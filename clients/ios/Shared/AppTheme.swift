import SwiftUI

/// The single accent used by the app and by its home-screen widgets. It lives in the shared target
/// so a widget amount and the same amount on screen cannot drift into two different greens.
enum AppTheme {
    static let accent = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.35, green: 0.83, blue: 0.66, alpha: 1)
            : UIColor(red: 0.08, green: 0.47, blue: 0.35, alpha: 1)
    })
}
