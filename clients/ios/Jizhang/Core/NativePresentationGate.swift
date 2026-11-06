import Combine
import Foundation
import UIKit

enum NativePresentationTarget: Equatable {
    case workspace(NativeWorkspaceRoute)
    case recording(DailyRecordingIntent)
    case review(AssistantLaunchIntent)

    var key: String {
        switch self {
        case .workspace(let route): return "workspace:" + route.id
        case .recording(let intent): return "recording:" + intent.id.uuidString
        case .review(let intent): return "review:" + intent.id
        }
    }

    var deliveryKey: String? {
        switch self {
        case .workspace: return nil
        case .recording(let intent): return "recording:" + intent.id.uuidString
        case .review(let intent): return "review:" + intent.presentationID.uuidString
        }
    }

    func belongs(to identity: UUID) -> Bool {
        switch self {
        case .workspace: return true
        case .recording(let intent): return intent.apiIdentity == identity
        case .review(let intent): return intent.apiIdentity == identity
        }
    }
}

struct NativePresentationRequest: Identifiable, Equatable {
    let id: UUID
    let ownerIdentity: UUID
    var target: NativePresentationTarget
}

/// Requests survive a covered tab and are acknowledged only by the displayed destination.
@MainActor final class NativePresentationQueue: ObservableObject {
    let ownerIdentity: UUID
    @Published private(set) var requests: [NativePresentationRequest] = []
    @Published private(set) var notice: String?
    @Published private(set) var retryTicket = UUID()
    private var attemptedID: UUID?
    private var acknowledgedDeliveries = Set<String>()

    init(ownerIdentity: UUID) { self.ownerIdentity = ownerIdentity }
    var first: NativePresentationRequest? { requests.first }
    var observationID: String { (first?.id.uuidString ?? "none") + ":" + retryTicket.uuidString }

    @discardableResult
    func enqueue(_ target: NativePresentationTarget, owner: UUID) -> Bool {
        guard owner == ownerIdentity, target.belongs(to: ownerIdentity) else { return false }
        if let delivery = target.deliveryKey, acknowledgedDeliveries.contains(delivery) { return false }
        if let index = requests.firstIndex(where: { $0.target.key == target.key }) {
            requests[index].target = target
        } else {
            requests.append(NativePresentationRequest(id: UUID(), ownerIdentity: owner, target: target))
        }
        if notice != nil { retry() }
        return true
    }

    @discardableResult
    func beginPresentation(_ id: UUID) -> Bool {
        guard first?.id == id else { return false }
        attemptedID = id
        return true
    }

    @discardableResult
    func acknowledgeAppearance(_ id: UUID) -> Bool {
        guard first?.id == id, attemptedID == id else { return false }
        if let delivery = first?.target.deliveryKey { acknowledgedDeliveries.insert(delivery) }
        requests.removeFirst()
        attemptedID = nil; notice = nil
        return true
    }

    func deferPresentation(_ id: UUID) {
        guard first?.id == id else { return }
        notice = "打开请求已保留。请先完成或关闭当前弹窗，再点继续打开。"
    }

    func retry() { notice = nil; retryTicket = UUID() }
}

enum NativePresentationWait: Equatable { case ready, timedOut, cancelled }

/// A bounded observer, not a fixed delay that assumes UIKit has finished dismissing.
@MainActor struct NativePresentationGate {
    let available: @MainActor () -> Bool
    let maximumChecks: Int
    let pause: @MainActor () async throws -> Void

    init(available: @escaping @MainActor () -> Bool = { UIKitPresentationStatus.isFree() },
         maximumChecks: Int = 300,
         pause: @escaping @MainActor () async throws -> Void = { try await Task.sleep(for: .milliseconds(150)) }) {
        self.available = available; self.maximumChecks = max(1, maximumChecks); self.pause = pause
    }

    func wait(stillCurrent: @MainActor () -> Bool) async -> NativePresentationWait {
        // Let queued SwiftUI presentation changes reach UIKit before the first observation.
        await Task.yield()
        for index in 0..<maximumChecks {
            guard !Task.isCancelled, stillCurrent() else { return .cancelled }
            if available() { return .ready }
            if index + 1 < maximumChecks {
                do { try await pause() } catch { return .cancelled }
            }
        }
        return .timedOut
    }
}

@MainActor enum UIKitPresentationStatus {
    static func isFree() -> Bool {
        guard UIApplication.shared.applicationState == .active,
              let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
                .filter({ $0.activationState == .foregroundActive })
                .flatMap(\.windows).first(where: { $0.isKeyWindow && $0.windowLevel == .normal }),
              let root = window.rootViewController, root.viewIfLoaded?.window === window else { return false }
        return controllerTreeIsFree(root)
    }

    static func controllerTreeIsFree(_ controller: UIViewController) -> Bool {
        guard controller.presentedViewController == nil, !controller.isBeingPresented,
              !controller.isBeingDismissed, controller.transitionCoordinator == nil else { return false }
        return controller.children.allSatisfy { controllerTreeIsFree($0) }
    }
}
