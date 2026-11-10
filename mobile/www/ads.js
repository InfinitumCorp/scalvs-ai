// Optional AdMob banner via @capacitor-community/admob. The banner is a native
// view at the bottom of the screen, outside the existing connecting / offline
// HTML, and is never shown while ads are disabled (the default). When a banner
// is not shown, the existing layout is unchanged.
(function () {
  var inflight = null;

  window.scalvsAdsEnabled = function () {
    if (typeof window.SCALVS_ADS_ENABLED === 'boolean') return window.SCALVS_ADS_ENABLED;
    var cfg = window.SCALVS_ADS || {};
    return !!cfg.enabled;
  };

  window.startScalvsAds = function startScalvsAds() {
    if (inflight) return inflight;
    if (!window.scalvsAdsEnabled()) return Promise.resolve(false);
    var Capacitor = window.Capacitor;
    var AdMob = Capacitor && Capacitor.Plugins && Capacitor.Plugins.AdMob;
    if (!AdMob || !Capacitor.getPlatform || Capacitor.getPlatform() === 'web') {
      return Promise.resolve(false);
    }
    var cfg = window.SCALVS_ADS || {};
    var platform = Capacitor.getPlatform();
    var debug = typeof window.SCALVS_ADS_DEBUG === 'boolean' ? window.SCALVS_ADS_DEBUG : true;
    var banner = window.SCALVS_ADMOB_BANNER_ID;
    if (!banner) {
      banner = debug
        ? (platform === 'ios' ? cfg.testBannerIos : cfg.testBannerAndroid)
        : (platform === 'ios' ? cfg.releaseBannerIos : cfg.releaseBannerAndroid);
    }
    inflight = AdMob.requestConsentInfo()
      .then(function (info) {
        if (info && info.isConsentFormAvailable && info.status === 'REQUIRED') {
          return AdMob.showConsentForm();
        }
        return info;
      })
      .then(function (info) {
        if (!info || !info.canRequestAds) return false;
        return AdMob.initialize({ initializeForTesting: !!debug }).then(function () {
          return AdMob.showBanner({
            adId: banner,
            adSize: 'ADAPTIVE_BANNER',
            position: 'BOTTOM_CENTER',
            margin: 0,
            isTesting: !!debug
          });
        }).then(function () { return true; });
      })
      .catch(function () {
        inflight = null;
        return false;
      });
    return inflight;
  };
})();
