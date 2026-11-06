import SwiftUI
import UIKit
import XCTest
@testable import Jizhang

final class LedgerBillStatisticsPreviewTests: XCTestCase {
    /// Exercise the vertical layout with accessibility text and the largest accepted cents.
    /// The exported render is visual evidence, separate from physical-device scrolling.
    @MainActor
    func testDailyStatisticsWithLargeAmountsAndAccessibilityText() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first { $0.isKeyWindow }
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        let controller = UIHostingController(rootView:
            ScrollView {
                VStack(spacing: 20) {
                    Text("界面预览 · 测试数据").font(.caption).foregroundStyle(.secondary)
                    LedgerDaySummaryHeader(day: "2026-11-06", summary: LedgerDaySummary(
                        day: "2026-11-06", expenseCents: LedgerDaySummaryPage.maximumCents,
                        incomeCents: 125_600, count: 128))
                    LedgerDaySummaryHeader(day: "2026-11-05", summary: nil)
                    LedgerDaySummaryHeader(day: "2026-11-04", summary: nil, summaryAvailable: false)
                }.padding(20)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .environment(\.dynamicTypeSize, .accessibility1)
        )
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        try await Task.sleep(for: .milliseconds(500))
        window.layoutIfNeeded()
        let screenshot = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: screenshot)
        attachment.name = "bill-statistics-large-amounts-accessibility-synthetic"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
