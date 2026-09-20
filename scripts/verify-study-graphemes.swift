// Standalone shared-contract check; does not build or launch the iOS app.
import Foundation
struct Fixture: Decodable { let text: String; let lower: Int; let upper: Int; let selected: String }
let path = CommandLine.arguments.dropFirst().first ?? "contracts/study-selection-fixtures.json"
let fixtures = try JSONDecoder().decode([Fixture].self, from: Data(contentsOf: URL(fileURLWithPath: path)))
for fixture in fixtures {
    let characters = Array(fixture.text)
    precondition(String(characters[fixture.lower..<fixture.upper]) == fixture.selected)
}
print("Verified \(fixtures.count) shared grapheme selections with Swift Character offsets.")
