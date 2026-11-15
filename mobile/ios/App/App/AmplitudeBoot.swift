import AmplitudeSwift
import Foundation

/// Privacy-first Amplitude iOS SDK. Public API key only (not the Secret key).
/// Sessions, app lifecycles and screen views only. No element interactions,
/// no session replay, no IP tracking. Does not change any existing UI.
enum AmplitudeBoot {
    static let apiKey = "756c0bc80c5cb27386bfd7b2b13196c8"
    private static var started = false

    static func start() {
        if started { return }
        started = true
        let tracking = TrackingOptions()
            .disableTrackIpAddress()
            .disableTrackCity()
            .disableTrackDMA()
            .disableTrackRegion()
            .disableTrackIDFV()
        let config = Configuration(
            apiKey: apiKey,
            serverZone: .US,
            trackingOptions: tracking,
            autocapture: [.sessions, .appLifecycles, .screenViews],
            enableAutoCaptureRemoteConfig: false,
            enableDiagnostics: false
        )
        _ = Amplitude(configuration: config)
    }
}
