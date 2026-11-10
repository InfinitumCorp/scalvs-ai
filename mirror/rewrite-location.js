// CloudFront Function (viewer response) for the SCALVS.ai mirror.
// The mirror fetches everything from https://scalvs.app. Redirects that point
// back at scalvs.app are rewritten to the mirror's own host, so visitors who
// can't reach scalvs.app (for example in Russia) stay on the mirror.
function handler(event) {
  var res = event.response;
  var loc = res.headers.location;
  if (loc && loc.value) {
    var host = event.request.headers.host ? event.request.headers.host.value : '';
    if (host) loc.value = loc.value.replace(/^https:\/\/(www\.)?scalvs\.app(?=\/|$)/, 'https://' + host);
  }
  return res;
}
