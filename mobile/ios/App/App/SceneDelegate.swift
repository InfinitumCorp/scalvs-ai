import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()
        injectAdsConfig()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    /// Pushes debug vs release banner IDs and the ADS_ENABLED flag into the
    /// Capacitor WebView. Ads stay off until `enabled` is flipped to true.
    private func injectAdsConfig() {
        #if DEBUG
        let debug = "true"
        let banner = "ca-app-pub-3940256099942544/2934735716"
        #else
        let debug = "false"
        let banner = "ca-app-pub-7308175971826620/4686610539"
        #endif
        let enabled = "false"
        let js = "window.SCALVS_ADS_DEBUG=\(debug);window.SCALVS_ADS_ENABLED=\(enabled);window.SCALVS_ADMOB_BANNER_ID='\(banner)';window.startScalvsAds&&window.startScalvsAds();"
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            (self?.window?.rootViewController as? CAPBridgeViewController)?
                .bridge?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
