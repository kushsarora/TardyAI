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
                    .preferredColorScheme(.dark)
            case .failure(let error):
                ContentUnavailableView("Couldn’t load the map",
                                       systemImage: "exclamationmark.triangle",
                                       description: Text(String(describing: error)))
            }
        }
    }
}

extension Color {
    /// HoloMap's green: the web app's green, lifted so it reads on the dark hologram.
    static let holoGreen = Color(red: 0.16, green: 0.62, blue: 0.45)
    static let holoIvory = Color(red: 0.98, green: 0.97, blue: 0.93)
}
