import CryptoKit
import Foundation

enum DailyReminderKind: String, Codable, CaseIterable, Hashable {
    case recording
    case review
}

enum DailyReminderAuthorization: Equatable {
    case notDetermined, denied, authorized, provisional, ephemeral, unknown

    var allowsDelivery: Bool { self == .authorized || self == .provisional || self == .ephemeral }
}

struct DailyReminderClock: Codable, Equatable {
    var hour: Int
    var minute: Int
    var isValid: Bool { (0...23).contains(hour) && (0...59).contains(minute) }
    var text: String { String(format: "%02d:%02d", hour, minute) }

    var date: Date {
        Calendar.current.date(from: DateComponents(year: 2001, month: 1, day: 1, hour: hour, minute: minute)) ?? Date()
    }

    init(hour: Int, minute: Int) { self.hour = hour; self.minute = minute }
    init(date: Date) {
        let components = Calendar.current.dateComponents([.hour, .minute], from: date)
        hour = components.hour ?? 20; minute = components.minute ?? 0
    }
}

struct DailyReminderPreferences: Codable, Equatable {
    var recordingEnabled = true
    var reviewEnabled = true
    var recordingTime = DailyReminderClock(hour: 20, minute: 0)
    var reviewTime = DailyReminderClock(hour: 21, minute: 0)
    var isValid: Bool { recordingTime.isValid && reviewTime.isValid }
}

struct DailyReminderOwner: Equatable {
    let key: String
    let apiIdentity: UUID
    let supportsReview: Bool

    @MainActor init(api: APIClient, user: AuthenticatedUser) {
        let identity = user.id ?? "legacy:\(user.username)"
        let bytes = Data((api.baseURL.absoluteString + "\n" + identity).utf8)
        key = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        apiIdentity = api.identity
        supportsReview = user.id != nil
    }
}

struct DailyReminderRequest: Equatable {
    static let prefix = "jizhang.daily.v1."
    let ownerKey: String
    let kind: DailyReminderKind
    let clock: DailyReminderClock
    var identifier: String { Self.prefix + ownerKey + "." + kind.rawValue }
}

struct DailyReminderDelivery: Equatable {
    let ownerKey: String
    let kind: DailyReminderKind
    let deliveredAt: Date

    init?(identifier: String, userInfo: [AnyHashable: Any], date: Date) {
        guard userInfo["version"] as? Int == 1,
              let owner = userInfo["owner"] as? String,
              owner.count == 64, owner.allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
              let rawKind = userInfo["kind"] as? String, let kind = DailyReminderKind(rawValue: rawKind),
              identifier == DailyReminderRequest.prefix + owner + "." + rawKind,
              date.timeIntervalSince1970.isFinite, date.timeIntervalSince1970 > 0 else { return nil }
        ownerKey = owner; self.kind = kind; deliveredAt = date
    }

    init(ownerKey: String, kind: DailyReminderKind, deliveredAt: Date) {
        self.ownerKey = ownerKey; self.kind = kind; self.deliveredAt = deliveredAt
    }
}

struct DailyRecordingIntent: Equatable, Identifiable {
    let id = UUID()
    let apiIdentity: UUID
}

/// A notification tap authorizes this one frozen, read-only review request.
struct AssistantLaunchIntent: Equatable, Identifiable {
    let id: String
    let apiIdentity: UUID
    let date: String
    let timeZone: String
    let clientRequestID: String
    let conversationID: String?
    let mayStart: Bool
    let presentationID: UUID

    init(id: String, apiIdentity: UUID, date: String, timeZone: String, clientRequestID: String,
         conversationID: String?, mayStart: Bool, presentationID: UUID = UUID()) {
        self.id = id; self.apiIdentity = apiIdentity; self.date = date; self.timeZone = timeZone
        self.clientRequestID = clientRequestID; self.conversationID = conversationID
        self.mayStart = mayStart; self.presentationID = presentationID
    }
}

enum DailyReviewCheckpoint {
    case conversation(String)
    case submitting(String)
    case accepted(String)
    case uncertain(String)
}

struct DailyReviewOutboxEntry: Codable, Equatable {
    enum State: String, Codable { case requested, bound, submitting, accepted, uncertain }
    let id: String
    let ownerKey: String
    let date: String
    let timeZone: String
    let clientRequestID: String
    var conversationID: String?
    var generationID: String?
    var state: State

    static let ledgerTimeZone = "Asia/Shanghai"

    static func day(containing date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: ledgerTimeZone)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    var isValid: Bool {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: Self.ledgerTimeZone)
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.isLenient = false
        guard let parsed = formatter.date(from: date), formatter.string(from: parsed) == date else { return false }
        return ownerKey.count == 64 && date.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil &&
        id == ownerKey + "." + date && timeZone == Self.ledgerTimeZone &&
        !clientRequestID.isEmpty && clientRequestID.utf16.count <= 120 &&
        (state == .requested || conversationID.map({ !$0.isEmpty }) == true) &&
        (state != .accepted || generationID.map({ !$0.isEmpty }) == true)
    }

    func launch(for owner: DailyReminderOwner, presentationID: UUID = UUID()) -> AssistantLaunchIntent {
        AssistantLaunchIntent(id: id, apiIdentity: owner.apiIdentity, date: date, timeZone: timeZone,
                              clientRequestID: clientRequestID, conversationID: conversationID, mayStart: state == .requested,
                              presentationID: presentationID)
    }
}
