import SwiftUI
import WidgetKit

@main
struct JizhangWidgetBundle: WidgetBundle {
    var body: some Widget {
        LedgerBalanceWidget()
        LedgerPurposeWidget()
    }
}
