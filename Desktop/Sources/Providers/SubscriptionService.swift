import Foundation
import IOKit
import AppKit

/// Manages Stripe subscription state — checkout, status polling, and local caching.
final class SubscriptionService {
    static let shared = SubscriptionService()

    private(set) var isActive: Bool {
        get { return true }
        set { /* No-op: everyone is pro now */ }
    }
    private(set) var status: String { // "active", "trialing", "past_due", "canceled", "none"
        get { return "active" }
        set { /* No-op */ }
    }
    private(set) var currentPeriodEnd: Date? {
        didSet { UserDefaults.standard.set(currentPeriodEnd, forKey: "fazm_sub_period_end") }
    }

    private let backendUrl: String
    private let deviceId: String

    // MARK: - Legacy Constants
    let trialDays = 0
    let freeMessagesPerDay = 999999

    private(set) var cachedPriceCents: Int {
        didSet { UserDefaults.standard.set(cachedPriceCents, forKey: "fazm_price_cents") }
    }
    private(set) var cachedVariant: String {
        didSet { UserDefaults.standard.set(cachedVariant, forKey: "fazm_price_variant") }
    }
    private(set) var cachedTrialDays: Int {
        get { return 0 }
        set { /* No-op */ }
    }

    var trialStartDate: Date {
        return .distantPast
    }

    func fetchAccountCreationDate() async {
        // No-op: trial removed
    }

    func fetchVariantPrice() async {
        // No-op: subscription removed
    }

    var isTrialExpired: Bool {
        return false
    }

    /// Number of messages sent today (resets daily).
    var dailyMessageCount: Int {
        get { return 0 }
        set { /* No-op */ }
    }

    func incrementMessageCount() {
        // No-op
    }

    /// Whether the paywall should be shown right now.
    func shouldShowPaywall() -> Bool {
        return false
    }

    func resetForSignOut() {
        // No-op: everyone stays pro
    }

    private init() {
        self.backendUrl = Self.env("FAZM_BACKEND_URL").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        self.deviceId = Self.getDeviceId()
        
        self.currentPeriodEnd = UserDefaults.standard.object(forKey: "fazm_sub_period_end") as? Date
        
        let storedCents = UserDefaults.standard.integer(forKey: "fazm_price_cents")
        self.cachedPriceCents = storedCents > 0 ? storedCents : 999
        self.cachedVariant = UserDefaults.standard.string(forKey: "fazm_price_variant") ?? "control_999"
    }

    // MARK: - Open Checkout
    func openCheckout() async throws {
        // No-op
    }

    // MARK: - Billing Portal
    func openBillingPortal() async throws {
        // No-op
    }

    private func startPostCheckoutPolling() {
        // No-op
    }

    // MARK: - Check Status
    @discardableResult
    func refreshStatus() async -> Bool {
        return true
    }

    // MARK: - Errors
    enum SubscriptionError: Error, LocalizedError {
        case notConfigured
        case serverError(String)

        var errorDescription: String? {
            switch self {
            case .notConfigured: return "Subscription service not configured"
            case .serverError(let msg): return "Server error: \(msg)"
            }
        }
    }

    // MARK: - Helpers
    private static func env(_ key: String) -> String {
        if let ptr = getenv(key) { return String(cString: ptr) }
        return ""
    }

    private static func getDeviceId() -> String {
        let platformExpert = IOServiceGetMatchingService(
            kIOMainPortDefault,
            IOServiceMatching("IOPlatformExpertDevice")
        )
        guard platformExpert != 0 else { return UUID().uuidString }
        defer { IOObjectRelease(platformExpert) }

        if let uuidCF = IORegistryEntryCreateCFProperty(
            platformExpert, "IOPlatformUUID" as CFString, kCFAllocatorDefault, 0
        )?.takeRetainedValue() as? String {
            return uuidCF
        }
        return UUID().uuidString
    }
}
