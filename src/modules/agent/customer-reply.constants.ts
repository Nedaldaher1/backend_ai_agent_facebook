/**
 * Customer-facing fallback line, shown when the agent cannot produce a real
 * reply this turn:
 *  - AgentService: the model returned empty text even after one retry.
 *  - Messenger worker: the async batch hit a system error (outer safety net).
 *
 * Brand voice: NO emoji. Keep it short and reassuring.
 */
export const FALLBACK_REPLY =
  'لحظة من فضلك، عم نجهّزلك الرد — جرّبي تبعتي رسالتك بعد شوي.';
