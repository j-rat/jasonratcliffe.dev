// CloudFront Function (cloudfront-js-2.0), viewer-request on the default behavior.
//  1. www.<domain> -> 301 to the apex (hard-coded target: no open redirect via Host).
//  2. Clean URLs: /blog/post and /blog/post/ -> /blog/post/index.html in the private bucket.
var APEX = '${apex}';

function qs(query) {
  var parts = [];
  for (var key in query) {
    var item = query[key];
    if (item.multiValue) {
      for (var i = 0; i < item.multiValue.length; i++) parts.push(key + '=' + item.multiValue[i].value);
    } else if (item.value !== undefined && item.value !== '') {
      parts.push(key + '=' + item.value);
    } else {
      parts.push(key);
    }
  }
  return parts.length ? '?' + parts.join('&') : '';
}

function handler(event) {
  var request = event.request;
  var host = request.headers.host ? request.headers.host.value.toLowerCase() : '';

  if (host !== APEX) {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {
        location: { value: 'https://' + APEX + request.uri + qs(request.querystring) },
        'strict-transport-security': { value: 'max-age=63072000; includeSubDomains; preload' },
      },
    };
  }

  var uri = request.uri;
  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
  } else if (uri.split('/').pop().indexOf('.') === -1) {
    request.uri = uri + '/index.html';
  }
  return request;
}
