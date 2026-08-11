import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { llmConfig, llmHost, studentDataEgressAllowed } from './llm';
import { isAiResumeEnabled, resumeModelHost, resumeWriterBlocked } from './resume';

/**
 * The gate that turns a comment into a rule.
 *
 * `resume.ts` has always said the local model is preferred "because the
 * evidence pack is a student's name, USN, email, attendance and grades", and
 * `.env.example` has always warned that "anything off this machine sends the
 * student's record to a third party". Neither statement was enforced anywhere:
 * `LLM_BASE_URL` accepted an OpenRouter URL and the screen still told the
 * student their record was staying put.
 *
 * Every case below is a configuration a `.env` file can actually hold.
 */

const LOCAL = 'http://127.0.0.1:11434/v1';
const REMOTE = 'https://openrouter.ai/api/v1';

beforeEach(() => {
  // Start from nothing configured, so a developer's real .env cannot make these
  // pass or fail by accident.
  vi.stubEnv('LLM_BASE_URL', '');
  vi.stubEnv('LLM_MODEL', '');
  vi.stubEnv('LLM_API_KEY', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('LLM_ALLOW_REMOTE_STUDENT_DATA', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function configure(baseUrl: string, model = 'reep-gemma3') {
  vi.stubEnv('LLM_BASE_URL', baseUrl);
  vi.stubEnv('LLM_MODEL', model);
  return llmConfig()!;
}

describe('llmHost', () => {
  it('calls a loopback server local', () => {
    expect(llmHost(configure(LOCAL))).toBe('local');
  });

  it('calls anything else remote', () => {
    expect(llmHost(configure(REMOTE))).toBe('remote');
  });

  it('calls a campus LAN address remote, because it is still another machine', () => {
    expect(llmHost(configure('http://192.168.1.50:11434/v1'))).toBe('remote');
  });
});

describe('studentDataEgressAllowed', () => {
  it('allows a local server without any opt-in', () => {
    expect(studentDataEgressAllowed(configure(LOCAL))).toBe(true);
  });

  it('REFUSES a remote server by default', () => {
    // The defect, as an assertion.
    expect(studentDataEgressAllowed(configure(REMOTE))).toBe(false);
  });

  it('allows a remote server once an operator opts in explicitly', () => {
    const config = configure(REMOTE);
    vi.stubEnv('LLM_ALLOW_REMOTE_STUDENT_DATA', 'true');

    expect(studentDataEgressAllowed(config)).toBe(true);
  });

  it('treats the opt-in as case-insensitive and whitespace-tolerant', () => {
    const config = configure(REMOTE);
    vi.stubEnv('LLM_ALLOW_REMOTE_STUDENT_DATA', '  TRUE  ');

    expect(studentDataEgressAllowed(config)).toBe(true);
  });

  it.each(['false', '1', 'yes', 'on', '', 'TRUE_ISH'])(
    'does not accept %j as consent — only the exact word true opts in',
    (value) => {
      const config = configure(REMOTE);
      vi.stubEnv('LLM_ALLOW_REMOTE_STUDENT_DATA', value);

      expect(studentDataEgressAllowed(config)).toBe(false);
    },
  );

  it('ignores the opt-in for a local server, which never needed it', () => {
    const config = configure(LOCAL);
    vi.stubEnv('LLM_ALLOW_REMOTE_STUDENT_DATA', 'false');

    expect(studentDataEgressAllowed(config)).toBe(true);
  });
});

describe("studentDataEgressAllowed('anthropic')", () => {
  /**
   * The path that had no gate at all.
   *
   * `resume.ts` entered the Anthropic branch on `ANTHROPIC_API_KEY` alone, and
   * because the check took an `LlmConfig` — which that path never builds — there
   * was nothing to call it from. A `.env` holding only a key is the default
   * shipping configuration for this feature, so the brief went to
   * api.anthropic.com in the setup an operator was most likely to have.
   */

  it('REFUSES Anthropic by default — a key names the recipient, it does not consent', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');

    expect(studentDataEgressAllowed('anthropic')).toBe(false);
  });

  it('allows Anthropic once an operator sets the flag to exactly "true"', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    vi.stubEnv('LLM_ALLOW_REMOTE_STUDENT_DATA', 'true');

    expect(studentDataEgressAllowed('anthropic')).toBe(true);
  });

  it.each(['false', '1', 'yes', 'on', '', 'TRUE_ISH'])(
    'does not accept %j as consent for Anthropic either',
    (value) => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
      vi.stubEnv('LLM_ALLOW_REMOTE_STUDENT_DATA', value);

      expect(studentDataEgressAllowed('anthropic')).toBe(false);
    },
  );

  it('answers for a bare destination as well as a config, so all three paths share one gate', () => {
    // The point of the union: a caller with no `LlmConfig` in hand still has
    // exactly one function to reach for, and no reason to invent a second.
    expect(studentDataEgressAllowed('local')).toBe(true);
    expect(studentDataEgressAllowed('remote')).toBe(false);
    expect(studentDataEgressAllowed(configure(LOCAL))).toBe(true);
  });
});

describe('resumeModelHost', () => {
  it('is null when nothing is configured', () => {
    expect(resumeModelHost()).toBeNull();
    expect(isAiResumeEnabled()).toBe(false);
  });

  it('is local for a loopback LLM_BASE_URL', () => {
    configure(LOCAL);

    expect(resumeModelHost()).toBe('local');
  });

  it('is REMOTE for a hosted LLM_BASE_URL, which is what the banner reads', () => {
    // Before the fix this returned 'local' and the page rendered
    // "Your record is not leaving this machine" over an OpenRouter call.
    configure(REMOTE);

    expect(resumeModelHost()).toBe('remote');
  });

  it('is anthropic only when no OpenAI-compatible server is configured', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');

    expect(resumeModelHost()).toBe('anthropic');
  });

  it('prefers the configured server over Anthropic, matching which path runs', () => {
    configure(LOCAL);
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');

    expect(resumeModelHost()).toBe('local');
  });
});

describe('resumeWriterBlocked', () => {
  it('is false when nothing is configured — the fallback is the plan, not a refusal', () => {
    expect(resumeWriterBlocked()).toBe(false);
  });

  it('is false for a local model', () => {
    configure(LOCAL);

    expect(resumeWriterBlocked()).toBe(false);
  });

  it('is TRUE for a remote model with no opt-in', () => {
    configure(REMOTE);

    expect(resumeWriterBlocked()).toBe(true);
  });

  it('is false once the operator opts in', () => {
    configure(REMOTE);
    vi.stubEnv('LLM_ALLOW_REMOTE_STUDENT_DATA', 'true');

    expect(resumeWriterBlocked()).toBe(false);
  });

  it('is TRUE for an Anthropic-only setup with no opt-in', () => {
    // The defect this file was extended for. `llmConfig()` is null here, so the
    // old `config !== null &&` short-circuited to false: the banner said nothing
    // was blocked while the brief was on its way to api.anthropic.com.
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');

    expect(resumeModelHost()).toBe('anthropic');
    expect(resumeWriterBlocked()).toBe(true);
  });

  it('is false once the operator opts Anthropic in', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    vi.stubEnv('LLM_ALLOW_REMOTE_STUDENT_DATA', 'true');

    expect(resumeWriterBlocked()).toBe(false);
  });

  it('is false for a loopback server even with an Anthropic key sitting in .env', () => {
    // The local path wins and never leaves the machine, so the ungated key
    // behind it is irrelevant — gating must not turn a working local setup into
    // a refusal.
    configure(LOCAL);
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');

    expect(resumeModelHost()).toBe('local');
    expect(resumeWriterBlocked()).toBe(false);
  });

  it('never reports both a green banner and a blocked writer', () => {
    // The screen renders these independently, so the pair must stay coherent:
    // "not leaving this machine" and "refused to send" cannot both be true.
    for (const url of [LOCAL, REMOTE, 'http://192.168.1.50:8000/v1']) {
      configure(url);
      expect(resumeModelHost() === 'local' && resumeWriterBlocked()).toBe(false);
    }
  });

  it('reports blocked in every configuration that would send the record off-machine', () => {
    // The banner is the promise; this is the sweep that keeps it honest. For
    // each .env a deployment can hold: if the destination is not this machine
    // and the operator has not opted in, the screen must say so.
    const cases: { baseUrl: string | null; key: boolean; optIn: boolean; blocked: boolean }[] = [
      { baseUrl: null, key: false, optIn: false, blocked: false },
      { baseUrl: null, key: true, optIn: false, blocked: true },
      { baseUrl: null, key: true, optIn: true, blocked: false },
      { baseUrl: LOCAL, key: false, optIn: false, blocked: false },
      { baseUrl: LOCAL, key: true, optIn: false, blocked: false },
      { baseUrl: REMOTE, key: false, optIn: false, blocked: true },
      { baseUrl: REMOTE, key: true, optIn: false, blocked: true },
      { baseUrl: REMOTE, key: true, optIn: true, blocked: false },
    ];

    for (const { baseUrl, key, optIn, blocked } of cases) {
      // Every variable is restated each round rather than cleared, because
      // `unstubAllEnvs` would hand the loop the developer's real .env back.
      vi.stubEnv('LLM_BASE_URL', baseUrl ?? '');
      vi.stubEnv('LLM_MODEL', baseUrl ? 'reep-gemma3' : '');
      vi.stubEnv('ANTHROPIC_API_KEY', key ? 'sk-ant-test' : '');
      vi.stubEnv('LLM_ALLOW_REMOTE_STUDENT_DATA', optIn ? 'true' : '');

      expect({ baseUrl, key, optIn, blocked: resumeWriterBlocked() }).toEqual({
        baseUrl,
        key,
        optIn,
        blocked,
      });
    }
  });
});
