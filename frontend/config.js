window.CHGL_CONFIG = (function () {
  var LOCAL = 'http://localhost:4000/api';
  var PROD = 'https://capitalhosierygarments2-0.onrender.com/api';
  var isLocal =
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1' ||
    location.hostname === '';

  return { API_BASE: isLocal ? LOCAL : PROD };
})();
