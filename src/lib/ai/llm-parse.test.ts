import { describe, expect, it } from 'vitest';

import { estimateTokens, extractJson, isLoopbackHost } from './llm-parse';

/**
 * These are the shapes a 12B model actually returns. The point of the module is
 * that none of them should reach the caller as a half-parsed object, so every
 * case here asserts either the right object or `undefined` — never a partial.
 */

describe('estimateTokens', () => {
  it('is zero for empty text', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('grows with length', () => {
    expect(estimateTokens('x'.repeat(3400))).toBe(1000);
    expect(estimateTokens('x'.repeat(6800))).toBe(2000);
  });

  it('rounds up, so a short string is never estimated at zero tokens', () => {
    expect(estimateTokens('hi')).toBe(1);
  });

  it('errs low on the divisor, so the guard trips before the real window does', () => {
    // A crude estimate is fine; one that under-counts is not, because the whole
    // job is catching "this prompt is twice the window".
    const text = 'a'.repeat(10_000);

    expect(estimateTokens(text)).toBeGreaterThan(text.length / 4);
  });
});

describe('isLoopbackHost', () => {
  /**
   * This predicate is the difference between a true statement and a false one
   * on the student's screen. `/student/resume` promises "your record is not
   * leaving this machine"; the promise is only kept if this function is right,
   * and it used to not exist at all — a configured model was assumed to be
   * local, so pointing `LLM_BASE_URL` at an aggregator kept the banner green.
   */

  it('accepts the Ollama default from .env.example', () => {
    expect(isLoopbackHost('http://127.0.0.1:11434/v1')).toBe(true);
  });

  it('accepts localhost and the LM Studio default', () => {
    expect(isLoopbackHost('http://localhost:11434/v1')).toBe(true);
    expect(isLoopbackHost('http://127.0.0.1:1234/v1')).toBe(true);
  });

  it('accepts the whole 127.0.0.0/8 block, not just 127.0.0.1', () => {
    expect(isLoopbackHost('http://127.0.0.2:8000')).toBe(true);
    expect(isLoopbackHost('http://127.255.255.254:8000')).toBe(true);
  });

  it('accepts IPv6 loopback in both spellings', () => {
    expect(isLoopbackHost('http://[::1]:11434/v1')).toBe(true);
    expect(isLoopbackHost('http://[0:0:0:0:0:0:0:1]:11434/v1')).toBe(true);
  });

  it('accepts the unspecified address, which is what Ollama binds', () => {
    expect(isLoopbackHost('http://0.0.0.0:11434/v1')).toBe(true);
  });

  it.each([
    'https://openrouter.ai/api/v1',
    'https://api.groq.com/openai/v1',
    'https://generativelanguage.googleapis.com/v1beta/openai',
    'https://api.openai.com/v1',
    'http://192.168.1.50:11434/v1',
    'http://10.0.0.7:8000/v1',
    'https://reep-llm.bgscet.ac.in/v1',
  ])('rejects %s — every one of these is documented in .env.example or plausible on a campus LAN', (url) => {
    expect(isLoopbackHost(url)).toBe(false);
  });

  it('rejects a hostname that merely contains a loopback-looking string', () => {
    // The near-misses an attacker or a typo produces.
    expect(isLoopbackHost('https://localhost.evil.com/v1')).toBe(false);
    expect(isLoopbackHost('https://127.0.0.1.evil.com/v1')).toBe(false);
    expect(isLoopbackHost('https://not-localhost/v1')).toBe(false);
  });

  it('rejects an octet out of range rather than reading it as loopback', () => {
    expect(isLoopbackHost('http://127.999.1.1:8000')).toBe(false);
  });

  it('fails closed on anything unparseable', () => {
    // A malformed URL is not a reason to assume the safe case.
    for (const bad of ['', '   ', 'not a url', 'localhost:11434', '://', 'ftp']) {
      expect(isLoopbackHost(bad)).toBe(false);
    }
  });

  it('tolerates surrounding whitespace, since the value comes from a .env file', () => {
    expect(isLoopbackHost('  http://127.0.0.1:11434/v1  ')).toBe(true);
  });

  it('ignores the port, the path and the scheme', () => {
    expect(isLoopbackHost('https://127.0.0.1/v1/chat/completions')).toBe(true);
    expect(isLoopbackHost('http://localhost')).toBe(true);
  });
});

describe('extractJson', () => {
  it('parses a reply that is nothing but the object', () => {
    expect(extractJson('{"summary":"ok"}')).toEqual({ summary: 'ok' });
  });

  it('tolerates surrounding whitespace and newlines', () => {
    expect(extractJson('\n\n  {"a":1}  \n')).toEqual({ a: 1 });
  });

  it('strips a markdown code fence', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('strips a reasoning trace', () => {
    expect(extractJson('<think>Let me plan this out.</think>{"a":1}')).toEqual({ a: 1 });
  });

  it('strips chat-template markers', () => {
    expect(extractJson('<|assistant|>{"a":1}<|end|>')).toEqual({ a: 1 });
  });

  it('survives a brace inside a string value', () => {
    // A resume bullet mentioning code is the case that breaks a lazy regex.
    expect(extractJson('{"text":"used {curly} braces"}')).toEqual({
      text: 'used {curly} braces',
    });
  });

  it('survives an escaped quote inside a string value', () => {
    expect(extractJson('{"text":"she said \\"done\\""}')).toEqual({ text: 'she said "done"' });
  });

  it('handles nested objects and arrays', () => {
    expect(extractJson('{"a":{"b":[1,{"c":2}]}}')).toEqual({ a: { b: [1, { c: 2 }] } });
  });

  it('stops at the end of the object and ignores trailing commentary', () => {
    expect(extractJson('{"a":1}\n\nHope that helps!')).toEqual({ a: 1 });
  });

  it('returns undefined rather than half an object when the model was cut off', () => {
    // Lenient parsing here would be a resume missing sections nobody was told
    // about. Undefined lets the caller retry.
    expect(extractJson('{"a":1,"b":{"c":')).toBeUndefined();
  });

  it('returns undefined when there is no object at all', () => {
    expect(extractJson('')).toBeUndefined();
    expect(extractJson('I cannot help with that.')).toBeUndefined();
  });

  it('returns undefined for a top-level array, which is not the contract', () => {
    expect(extractJson('[1,2,3]')).toBeUndefined();
  });

  it('returns undefined for malformed JSON rather than throwing', () => {
    expect(() => extractJson("{'single':'quotes'}")).not.toThrow();
    expect(extractJson("{'single':'quotes'}")).toBeUndefined();
  });

  it('never throws, whatever it is handed', () => {
    for (const input of ['{', '}', '{}{}', '{"a":1', 'null', '{{{{', '"just a string"']) {
      expect(() => extractJson(input)).not.toThrow();
    }
  });

  it('parses an empty object', () => {
    expect(extractJson('{}')).toEqual({});
  });
});
