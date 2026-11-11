// Which assistant the Command Center composer is talking to.
//   @conjure <question>        Conjure™ prediction modeling (opens Forecasts with the question)
//   @scalvs / @scalus <task>   the SCALVS agent, which runs on an OpenClaw gateway
//   @search <question>         Infinitum Search: a web answer with numbered sources
// "@openclaw" is not a trigger. @conjure wins when a message has both, the same as +SPCTR.
export const SCALVS_MENTION = /(^|[^\w@＠./])[@＠]scal(?:vs|us)(?![\w-]|\.[a-z])/i;
export const SEARCH_MENTION = /(^|[^\w@＠./])[@＠]search(?![\w-]|\.[a-z])/i;
export const CONJURE_MENTION = /(^|[^\w@＠./])[@＠]conjure(?![\w-]|\.[a-z])/i;

export function mentionIn(text) {
  if (typeof text !== 'string') return null;
  if (CONJURE_MENTION.test(text)) return 'conjure';
  if (SCALVS_MENTION.test(text)) return 'scalvs';
  if (SEARCH_MENTION.test(text)) return 'search';
  return null;
}

/** The text with the @conjure mention taken out: the question for Forecasts. */
export function conjureQuestion(text) {
  return String(text).replace(CONJURE_MENTION, '$1').replace(/^[\s:,\-–—]+/, '').replace(/\s+/g, ' ').trim();
}
