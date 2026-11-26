# Stack: iOS app (Swift, SwiftUI)

## Verify ladder

| Rung | Typical command | Proves |
|---|---|---|
| fast | `swiftlint lint --quiet <changed files>` and the project's static gates | style, banned APIs, token drift |
| verify | `xcodebuild build` then `xcodebuild test` on a named simulator, through the project's wrapper if it has one | it compiles and the tests ran |
| runtime | launch on a simulator, screenshot each touched screen in light and dark, compare to goldens if the project keeps them | users see what the change intended |

`xcodebuild test` prints success when a filter matches nothing. Count executed tests from the log (`sous` ships `tests-ran` for this) and treat zero as red. Swift Testing suites do not match `-only-testing:` selectors written for XCTest.

## Done means

- Builds with no new warnings in the files you touched.
- The tests you added ran and failed before the fix.
- Each touched screen screenshotted in light and dark, at a large Dynamic Type size, and checked with VoiceOver labels.
- No hardcoded colors, fonts or spacing where the project has tokens.
- Empty, loading and error states exist for any new data view.

## Review for

- Concurrency: actor isolation, `@MainActor` on UI state, `Sendable` crossings, tasks that outlive their view.
- Force unwraps, `try!`, `fatalError` and other crash paths in shipping code.
- State that should live in the model but sits in a view.
- Main-thread work: decoding, image processing, disk I/O.
- Privacy: new data leaving the device, new permission prompts, new tracking.

## Product and design checks

- Follows the platform first: system navigation, sheets, controls and gestures before custom ones.
- One primary action per screen. Touch targets at least 44 pt.
- Motion only in response to the user, and it respects Reduce Motion.
- Copy is short, concrete and free of internal names.
- For taste, use a design skill if the project has one (for example `emil-design-eng` or `apple-design`) and a human eye. A screenshot is evidence; "looks good" is not.

## Traps

- Simulator state leaks between runs. Erase or reset only the simulator you created, never all of them.
- Snapshot goldens recorded on a different machine or OS version will drift. Record them where CI runs.
- One shared Mac often builds for several sessions at once. Use the project's build lock if it has one.
