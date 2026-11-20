import SwiftUI

@main
struct HoloMapApp: App {
    @State private var loaded: Result<AppModel, Error>

    init() {
        _loaded = State(initialValue: Result { try AppModel() })
    }

    var body: some Scene {
        WindowGroup {
            switch loaded {
            case .success(let model):
                ContentView(model: model)
                    .tint(.holoGreen)
            case .failure(let error):
                ContentUnavailableView("Couldn’t load the map",
                                       systemImage: "exclamationmark.triangle",
                                       description: Text(String(describing: error)))
            }
        }
    }
}

extension Color {
    /// HoloMap's green, carried over from the web app.
    static let holoGreen = Color(red: 0.18, green: 0.42, blue: 0.31)
    static let holoIvory = Color(red: 0.98, green: 0.97, blue: 0.93)
}
