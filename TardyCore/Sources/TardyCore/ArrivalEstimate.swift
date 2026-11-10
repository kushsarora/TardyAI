import Foundation

/// The TardyAI hook: "am I going to be late?"
public struct ArrivalVerdict: Equatable, Sendable {
    public var isLate: Bool
    /// "About 2 min late", "You'll arrive just in time", "3 min to spare".
    public var headline: String
    public var arrival: Date
    /// Minutes between arrival and class start; negative means late.
    public var slackMinutes: Double
}

public enum ArrivalEstimator {
    /// Compare leaving `now` and walking `routeSeconds` against a class that
    /// starts today at `hour:minute`. Lateness rounds up, spare time rounds down,
    /// so the student is never told they have more time than they do.
    public static func verdict(now: Date, classHour: Int, classMinute: Int, routeSeconds: Double,
                               calendar: Calendar = .current) -> ArrivalVerdict? {
        guard let start = calendar.date(bySettingHour: classHour, minute: classMinute, second: 0, of: now) else {
            return nil
        }
        let arrival = now.addingTimeInterval(routeSeconds)
        let slack = start.timeIntervalSince(arrival) / 60
        let headline: String
        if slack < 0 {
            headline = "About \(Int((-slack).rounded(.up))) min late"
        } else if slack < 1 {
            headline = "You’ll arrive just in time"
        } else {
            headline = "\(Int(slack.rounded(.down))) min to spare"
        }
        return ArrivalVerdict(isLate: slack < 0, headline: headline, arrival: arrival, slackMinutes: slack)
    }

    /// "4 min", "45 sec" — walking time as a student reads it.
    public static func durationText(seconds: Double) -> String {
        if seconds < 60 { return "\(max(1, Int(seconds.rounded()))) sec" }
        return "\(Int((seconds / 60).rounded(.up))) min"
    }
}
