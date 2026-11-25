# Spotify timed lyrics release gate

**Public starter handoff remains off.** The shipping app source contains several routes from Spotify App Remote player state to timed lyric displays, including routes reachable after leaving onboarding. The project materials reviewed contain an owner's decision to proceed with implementation and no Spotify-issued permission covering those uses. Spotify's compliance guidance explicitly includes synchronizing recordings with lyrics among its disallowed examples. [Compliance Tips, Disallowed use cases](https://developer.spotify.com/compliance-tips) · [Developer Policy, III.6](https://developer.spotify.com/policy)

## Shipping source inventory

This audit covers the app and embedded WidgetKit extension at Lyrica main `2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9`. References below point to that immutable source. Runtime, subscription-specific behavior and installed-build verification remain open. [App and extension target membership][project]

| Entry or display | Path from Spotify playback to lyrics |
| --- | --- |
| Connect, reconnect, scene activation and automatic following | App Remote supplies the observed track URI, pause state and position. On connection, the session subscribes, refreshes and begins polling. Scene activation enables source monitoring. The coordinator can select a fresh playing Spotify source automatically, or restore its selected Spotify driver. An authorization callback changes session state. The observed playback snapshot drives downstream consumers. The introduction cover suppresses ordinary automatic source switching and companion receipt while shown. Recheck the path on dismissal and on return to foreground. [SDK state][sdk] · [session subscription][session] · [driver snapshot][driver] · [automatic selection][auto] · [scene and callback][scene] |
| First-song picker, Home and explicit follow | The existing picker opens the generic Spotify app. Its separate Now playing action rechecks the row, resumes external following, follows the current snapshot and opens the player. Home's companion/source actions, the player's Current song action, Follow Spotify and automatic source selection can return to the same path after onboarding. [Picker actions][first] · [live picker binding][picker] · [Home follow][home] · [player source menu][menu] |
| Spotify Search, Library, Home and Learning playback | Search can hand a query to Spotify and observe a subsequent return. Native Spotify collections and saved-song actions use the coordinator. A successful selection and later external track changes can feed the existing companion even when the earlier starter was never played. Recheck a different track and explicit follow later in the session. [Search handoff][search] · [library playback][play] · [saved recording flow][saved] |
| Full player, Karaoke and timed Study controls | The companion follows the observed recording. Given matching content, fresh known position and an eligible timing source, the player updates the active line, karaoke emphasis and timed accents. Lyric replay seeks within the observed recording. A matching song page also offers bounded replay in its Study inspector and line-practice menu. Its ordinary text rows render with playback disabled. [Companion][companion] · [timing admission][clock] · [player rendering and replay][karaoke] · [song page and inspector][reader] |
| Mini player | The compact surface checks ownership of the document and matching playback, then projects configured lyric rows using the snapshot and timing offset. Tapping the mini player rejoins the companion and opens the player. [Mini player][mini] · [row selection][minirows] · [open action][miniopen] |
| Automatic and explicit Live Lyrics | The live controller subscribes to snapshots independently of opening the player. Fresh, playing Spotify can arm a session and a complete synchronized document can start an activity in foreground when admission checks pass. Explicit start also uses the current queue. An active Spotify activity can retain a background App Remote observation lease. Activity updates can also use the configured push relay. [Live lifecycle][lifecycle] · [session and start][live] · [projection, lease and updates][liveupdate] · [relay][relay] |
| Lock Screen and Dynamic Island | The widget renders Live Activity content on the Lock Screen and in the expanded Island. Compact and minimal Island presentations use artwork or the bird. The activity URL returns to the current player and calls follow. [Extension layouts][widget] · [return URL][deeplink] |
| Current lyrics widget and its in-app preview | The app projects timed content to the shared surface store. The widget selects a current authorized reading and schedules entries from its time boundaries. Settings and Lyric Tools can render that reading in a preview. The separate pinned-lyric widget displays a saved selection. [Shared projection][surface] · [widget timeline][current] · [settings preview][widgetpreview] |
| Floating lyrics, controls and shortcuts | The same projected Spotify line, pronunciation and translation can become a floating Picture in Picture frame. Lyric Tools, widget controls and the floating-lyrics shortcut can enter it. Live widget controls can also start the activity. Commands return through the app's recording-aware handler. [Floating adaptation][floating] · [Picture in Picture start][pip] · [controls][controls] · [shortcuts][shortcuts] · [command handling][commands] |

## Permission evidence and owner decision

The app's companion design specifically records the issue and states that no provider was contacted in that research. The integration plan records permission from the project owner to proceed with technical work. The Home redesign later records the owner's position that the policy concern was resolved. The subsequently approved onboarding design explicitly requires a product-wide decision before enabling track links. None of these documents supplies a provider-issued grant, scope, territories or covered displays. [Companion design][design] · [integration direction][implementation] · [Home decision][homedesign] · [approved onboarding decision][milestone]

A targeted search of tracked app and backend documents covered Spotify integration, research, licensing, permissions, exceptions and synchronized lyrics. Native setup and fresh-grant documents describe account authorization for the SDK. The recording contract describes exact item identity and timing eligibility. No app-specific synchronization agreement was found in that scope. A private agreement outside these repositories remains unknown. [Native setup][setup] · [fresh authorization repair][auth] · [recording contract][contract] · [prior policy research][research]

The native App Remote observation constructs `SpotifyRecording(itemID: id, metadata: metadata)` from the observed track URI. Its requested item ID and market are absent. The wire schema can carry these fields from other sources. This curation establishes no alternate Spotify URI or market relink for exclusion from own-music credit. [Observed recording construction][observed] · [SDK state][sdk]

Before enabling public links, the owner must establish applicable permission for each enabled synchronized use, or approve and verify a shipping build where every uncovered route above is unavailable. The approved verification includes Spotify Free and Premium, missing/offline Spotify, an unavailable track, a shuffled or different return track, a previously connected remote with Live Lyrics enabled, and manual follow on another track after leaving the picker. Preserve unrelated existing playback. Independent starter reading depends on the lyric source's own publication and territory grant. [Approved release conditions][milestone]

[project]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica.xcodeproj/project.pbxproj#L51
[sdk]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/SpotifySDKBridge.swift#L28
[observed]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/SpotifySessionModels.swift#L132
[session]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/SpotifySession.swift#L992
[driver]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/SpotifyPlaybackDriver.swift#L444
[auto]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/PlaybackCoordinator.swift#L974
[scene]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/ContentView.swift#L592
[first]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/FirstSong.swift#L249
[picker]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/ContentView.swift#L908
[home]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/ContentView.swift#L1032
[menu]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/PlayerScreen.swift#L2384
[search]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/ContentView.swift#L1218
[play]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/PlaybackCoordinator.swift#L257
[saved]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/PlaybackCoordinator.swift#L328
[companion]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/CompanionLyricsCoordinator.swift#L29
[clock]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/ContentView.swift#L575
[karaoke]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/PlayerScreen.swift#L2072
[reader]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/SongPage.swift#L338
[mini]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/CompanionMiniPlayer.swift#L54
[minirows]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/MiniPlayerLyrics.swift#L48
[miniopen]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/ContentView.swift#L1077
[lifecycle]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/LiveLyricsLifecycle.swift#L18
[live]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/LiveLyricsController.swift#L131
[liveupdate]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/LiveLyricsController.swift#L255
[relay]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/LiveLyricsController.swift#L406
[widget]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/LiveLyricsWidget/LiveLyricsWidget.swift#L13
[deeplink]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/ContentView.swift#L619
[surface]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/LyricSurfacePresentation.swift#L9
[current]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/LiveLyricsWidget/LiveLyricsWidget.swift#L67
[widgetpreview]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/LyricSurfaceSettingsView.swift#L9
[floating]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/LyricTools.swift#L38
[pip]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/FloatingLyrics.swift#L311
[controls]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/LiveLyricsWidget/LiveLyricsWidget.swift#L139
[shortcuts]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/LyricToolsShortcuts.swift#L11
[commands]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/Lyrica/ContentView.swift#L826
[design]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/docs/MUSIC_COMPANION_DESIGN.md#L147
[implementation]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/docs/SPOTIFY_INTEGRATION_PLAN.md#L17
[homedesign]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/docs/design/home-learning-redesign.md#L17
[milestone]: https://github.com/hongkuntian/Lyrica/blob/bdc9bc84de589664a3bab18dacbc1a8b8f5290f3/docs/design/onboarding-second-milestone.md#L19
[setup]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/docs/SPOTIFY_SETUP.md#L46
[auth]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/docs/research/SPOTIFY_FRESH_GRANT_REPAIR_20261116.md#L1
[contract]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/docs/SPOTIFY_RECORDING_CONTRACT.md#L49
[research]: https://github.com/hongkuntian/Lyrica/blob/2cc2c643ecc8d5b5aaec3d833561ac83ec00fac9/docs/research/SPOTIFY_ARCHITECTURE_RESEARCH_2026_10.md#L16
