import SwiftUI
import TardyCore

/// "Class starts at …" → "2 min to spare" / "About 3 min late", rechecked every 15 s.
struct ArrivalCard: View {
    let routeSeconds: Double

    @AppStorage("hasClassTime") private var hasClassTime = false
    @AppStorage("classTime") private var classTimeStorage = ArrivalCard.defaultClassTime.timeIntervalSinceReferenceDate

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle(isOn: $hasClassTime) {
                Label("I have class", systemImage: "clock")
            }
            if hasClassTime {
                DatePicker("Class starts at", selection: classTime, displayedComponents: .hourAndMinute)
                TimelineView(.periodic(from: .now, by: 15)) { context in
                    verdictView(now: context.date)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private var classTime: Binding<Date> {
        Binding(get: { Date(timeIntervalSinceReferenceDate: classTimeStorage) },
                set: { classTimeStorage = $0.timeIntervalSinceReferenceDate })
    }

    @ViewBuilder
    private func verdictView(now: Date) -> some View {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: classTime.wrappedValue)
        if let verdict = ArrivalEstimator.verdict(now: now, classHour: parts.hour ?? 0, classMinute: parts.minute ?? 0,
                                                  routeSeconds: routeSeconds) {
            HStack(spacing: 10) {
                Image(systemName: verdict.isLate ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                    .font(.title3)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verdict.headline).font(.headline)
                    Text("Leave now · arrive about \(verdict.arrival.formatted(date: .omitted, time: .shortened))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .foregroundStyle(verdict.isLate ? Color.red : Color.tardyGreen)
            .padding(10)
            .background((verdict.isLate ? Color.red : Color.tardyGreen).opacity(0.1),
                        in: RoundedRectangle(cornerRadius: 10))
            .accessibilityElement(children: .combine)
        }
    }

    /// The next whole hour, a sensible first guess for a class time.
    static var defaultClassTime: Date {
        let calendar = Calendar.current
        let now = Date()
        let hour = calendar.component(.hour, from: now)
        return calendar.date(bySettingHour: (hour + 1) % 24, minute: 0, second: 0, of: now) ?? now
    }
}
