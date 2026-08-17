import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';

import { ChatVoiceService, ChatTurn } from './chat-voice.service';

/**
 * Regression tests for the two transcript bugs that were invisible from the
 * outside: both produced a UI that looked correct while quietly losing or
 * mislabelling the student's own turns.
 *
 * Only the parts reachable without a LiveKit room are covered here. The session
 * state machine itself (cancellation, disconnect classification, mic release) is
 * driven against a real call in the browser, because the failures worth catching
 * there — a mic that stays live, a start that resurrects after cancel — are
 * properties of the actual WebRTC objects, not of a mock.
 */
describe('ChatVoiceService — transcript merging', () => {
  let service: ChatVoiceService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [ChatVoiceService, provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(ChatVoiceService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  function flushHistory(turns: ChatTurn[]) {
    const req = http.expectOne('/api/agent/history');
    expect(req.request.method).toBe('GET');
    req.flush({ conversation_id: 'c1', turns });
  }

  it('keeps the structured payload when the server sends back plain text', async () => {
    // A fresh /ask answer: action cards, sources, feedback controls.
    const answered: ChatTurn = {
      role: 'assistant',
      content: "You're 67/100 — On track.",
      structured: {
        answer: "You're 67/100 — On track.",
        actions: [{ label: 'Open certifications', route: '/student/certifications', reason: '' }],
        sources: [{ label: 'Your record', type: 'student-record' }],
        limitations: [],
        model: 'llama-3.3-70b',
        run_id: 'run-1',
      },
    };
    service.chatHistory.set([{ role: 'user', content: 'Am I placement-ready?' }, answered]);

    const done = service.refreshTranscript();
    // The server does not persist the structured payload — history is plain.
    flushHistory([
      { role: 'user', content: 'Am I placement-ready?' },
      { role: 'assistant', content: "You're 67/100 — On track." },
    ]);
    await done;

    const merged = service.chatHistory();
    expect(merged.length).toBe(2);
    // Assigning res.turns straight in used to strip this, so a student who asked
    // a question and then made a voice call watched their answer lose its "why".
    expect(merged[1].structured?.run_id).toBe('run-1');
    expect(merged[1].structured?.actions.length).toBe(1);
  });

  it('mirrors the server verbatim into voiceTranscript', async () => {
    const done = service.refreshTranscript();
    flushHistory([{ role: 'user', content: 'spoken turn' }]);
    await done;

    // voiceTranscript IS a faithful copy of the server; only chatHistory merges.
    expect(service.voiceTranscript()).toEqual([{ role: 'user', content: 'spoken turn' }]);
  });

  it('keeps a local turn the server has not caught up with', async () => {
    service.chatHistory.set([
      { role: 'user', content: 'already saved' },
      { role: 'user', content: 'still being persisted', status: 'failed' },
    ]);

    const done = service.refreshTranscript();
    flushHistory([{ role: 'user', content: 'already saved' }]);
    await done;

    // Otherwise an in-flight or failed turn vanishes and reappears.
    expect(service.chatHistory().map((t) => t.content)).toEqual([
      'already saved',
      'still being persisted',
    ]);
  });

  it('ignores a history response that lands after a newer one', async () => {
    const stale = service.refreshTranscript();
    const staleReq = http.expectOne('/api/agent/history');

    const fresh = service.refreshTranscript();
    const freshReq = http.expectOne('/api/agent/history');

    // The newer request answers first; the older one lands afterwards.
    freshReq.flush({ conversation_id: 'c1', turns: [{ role: 'user', content: 'newest' }] });
    await fresh;
    staleReq.flush({ conversation_id: 'c1', turns: [{ role: 'user', content: 'ancient' }] });
    await stale;

    expect(service.voiceTranscript().map((t) => t.content)).toEqual(['newest']);
  });
});

describe('ChatVoiceService — ask() failure marking', () => {
  let service: ChatVoiceService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [ChatVoiceService, provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(ChatVoiceService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('marks the turn it actually sent, even after a refresh rebuilds the array', async () => {
    // ask() used to capture `length - 1` as an INDEX. refreshTranscript rebuilds
    // chatHistory — a voice call ending mid-request is enough — so the index then
    // pointed at whichever turn happened to occupy that slot, and an unrelated
    // earlier message was flagged failed while the real one looked fine.
    service.chatHistory.set([
      { role: 'user', content: 'an older question' },
      { role: 'assistant', content: 'an older answer' },
    ]);

    // fetch is used (not HttpClient) so /ask can be aborted; fail it.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error('network down'));

    try {
      const pending = service.ask('the new question').catch(() => undefined);

      // A history refresh lands mid-request and rebuilds the array, shifting
      // every index.
      const refresh = service.refreshTranscript();
      http.expectOne('/api/agent/history').flush({
        conversation_id: 'c1',
        turns: [
          { role: 'user', content: 'an older question' },
          { role: 'assistant', content: 'an older answer' },
          { role: 'user', content: 'the new question' },
        ],
      });
      await refresh;
      await pending;

      const failed = service.chatHistory().filter((t) => t.status === 'failed');
      expect(failed.length).toBe(1);
      expect(failed[0].content).toBe('the new question');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
