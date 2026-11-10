// AdMob identifiers for SCALVS.ai. Ads stay off until `enabled` (and the
// native BuildConfig.ADS_ENABLED / iOS equivalent) is flipped to true.
// Debug builds should use the Google test banner units; release builds use
// the real units. Android MainActivity overwrites enabled/banner from Gradle.
window.SCALVS_ADS = {
  enabled: false,
  androidAppId: 'ca-app-pub-7308175971826620~7610167678',
  iosAppId: 'ca-app-pub-7308175971826620~6079583254',
  testBannerAndroid: 'ca-app-pub-3940256099942544/6300978111',
  testBannerIos: 'ca-app-pub-3940256099942544/2934735716',
  releaseBannerAndroid: 'ca-app-pub-7308175971826620/3564925547',
  releaseBannerIos: 'ca-app-pub-7308175971826620/4686610539'
};
