import Foundation

/// The deep links the home-screen widgets open. They are declared once so the widget's
/// `widgetURL` and the app's parser are tested against the same values.
enum LedgerWidgetLink {
    static let balance = URL(string: "jizhang://home")!
    static let purposes = URL(string: "jizhang://plan")!
}
