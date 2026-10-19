import XCTest
@testable import AuralisKit

final class MD5Tests: XCTestCase {
  func testKnownVectors() {
    XCTAssertEqual(MD5.hex(""), "d41d8cd98f00b204e9800998ecf8427e")
    XCTAssertEqual(MD5.hex("abc"), "900150983cd24fb0d6963f7d28e17f72")
    XCTAssertEqual(MD5.hex("The quick brown fox jumps over the lazy dog"), "9e107d9d372bb6826bd81d3542a419d6")
    // Longer than one 64-byte block, to exercise padding across chunks.
    XCTAssertEqual(MD5.hex(String(repeating: "a", count: 100)), "36a92cc94a9e0fa21f625f8bfb007adf")
  }

  // Subsonic spec example: password "sesame", salt "c19b2d" -> 26719a1196d2a940705a59634eb18eab
  func testSubsonicSpecToken() {
    XCTAssertEqual(MD5.hex("sesamec19b2d"), "26719a1196d2a940705a59634eb18eab")
  }
}

final class SubsonicClientTests: XCTestCase {
  private let creds = Credentials(baseURL: URL(string: "https://music.example.com")!, username: "ada", password: "sesame")

  private func client(_ body: String, status: Int = 200) -> SubsonicClient {
    SubsonicClient(credentials: creds, fetch: { _ in (Data(body.utf8), status) }, makeSalt: { "c19b2d" })
  }

  func testURLUsesTokenAuthAndNeverSendsPassword() {
    let url = client("{}").url("ping").absoluteString
    XCTAssertTrue(url.contains("t=26719a1196d2a940705a59634eb18eab"))
    XCTAssertTrue(url.contains("s=c19b2d"))
    XCTAssertFalse(url.contains("sesame"))
    XCTAssertTrue(url.hasPrefix("https://music.example.com/rest/ping?"))
  }

  func testNormalizeBaseURL() throws {
    XCTAssertEqual(try SubsonicClient.normalizeBaseURL(" music.example.com:4533/ ").absoluteString, "https://music.example.com:4533")
    XCTAssertEqual(try SubsonicClient.normalizeBaseURL("http://nas.local/navidrome/?x=1").absoluteString, "http://nas.local/navidrome")
    XCTAssertThrowsError(try SubsonicClient.normalizeBaseURL(""))
    XCTAssertThrowsError(try SubsonicClient.normalizeBaseURL("ftp://x"))
    XCTAssertThrowsError(try SubsonicClient.normalizeBaseURL("https://u:p@x.com"))
  }

  func testAlbumListMapsLeniently() async throws {
    let json = #"{"subsonic-response":{"status":"ok","version":"1.16.1","albumList2":{"album":[{"id":7,"title":"Numeric id","songCount":3},"junk",{"id":"a2","name":"B","artist":"Z","year":1999}]}}}"#
    let albums = try await client(json).newestAlbums()
    XCTAssertEqual(albums.map(\.id), ["7", "a2"])
    XCTAssertEqual(albums[0].name, "Numeric id")
    XCTAssertEqual(albums[1].year, 1999)
  }

  func testWrongCredentialsMapToAuthError() async {
    let json = #"{"subsonic-response":{"status":"failed","version":"1.16.1","error":{"code":40,"message":"Wrong"}}}"#
    do { try await client(json).ping(); XCTFail("expected throw") } catch { XCTAssertEqual(error as? SubsonicError, .auth) }
  }

  func testHTTPAndNonSubsonicBodies() async {
    do { try await client("x", status: 502).ping(); XCTFail() } catch { XCTAssertEqual(error as? SubsonicError, .http(502)) }
    do { try await client("<html>").ping(); XCTFail() } catch { XCTAssertEqual(error as? SubsonicError, .invalidResponse) }
  }

  func testNetworkFailureHidesURL() async {
    struct Boom: Error {}
    let c = SubsonicClient(credentials: creds, fetch: { _ in throw Boom() })
    do { try await c.ping(); XCTFail() } catch {
      XCTAssertEqual(error as? SubsonicError, .network)
      XCTAssertFalse((error.localizedDescription).contains("example.com"))
    }
  }

  func testSyncedLyricsSubtractsOffsetAndPrefersSynced() async throws {
    // OpenSubsonic: a positive offset shows lyrics sooner (same as the web client).
    let json = #"{"subsonic-response":{"status":"ok","version":"1.16.1","lyricsList":{"structuredLyrics":[{"synced":false,"line":[{"value":"plain"}]},{"synced":true,"offset":500,"line":[{"start":1000,"value":"one"},{"start":2000,"value":"two"}]}]}}}"#
    let lyrics = try await client(json).lyrics(songId: "s")
    XCTAssertEqual(lyrics?.synced, true)
    XCTAssertEqual(lyrics?.lines, [LyricLine(time: 0.5, text: "one"), LyricLine(time: 1.5, text: "two")])
  }

  func testSongMappingKeepsIsrcExplicitAndStar() async throws {
    let json = #"{"subsonic-response":{"status":"ok","version":"1.16.1","starred2":{"song":[{"id":"s1","title":"T","artistId":"ar","isrc":["usrc17607839","bad"],"explicitStatus":"clean","starred":"2024-01-01T00:00:00Z"}],"album":[{"id":"a","name":"A","created":"2024-05-09T18:24:17.207587011Z"}]}}}"#
    let r = try await client(json).starred()
    XCTAssertEqual(r.songs.first?.isrc, ["USRC17607839"])
    XCTAssertEqual(r.songs.first?.explicit, false)
    XCTAssertEqual(r.songs.first?.starred, true)
    XCTAssertEqual(r.songs.first?.artistId, "ar")
    XCTAssertEqual(r.albums.first?.created?.timeIntervalSince1970, 1_715_279_057)
    XCTAssertEqual(SubsonicClient.date("2024-05-09T20:24:17+02:00")?.timeIntervalSince1970, 1_715_279_057)
  }

  func testPlaylistEditsSendRepeatedParams() {
    let url = client("{}").url("updatePlaylist", [("playlistId", "p"), ("songIndexToRemove", "0"), ("songIndexToRemove", "2")]).absoluteString
    XCTAssertTrue(url.contains("songIndexToRemove=0&songIndexToRemove=2"))
  }
}

final class PlayQueueTests: XCTestCase {
  private let songs = (1...4).map { Song(id: "\($0)", title: "T\($0)") }

  func testNextStopsAtEndAndRepeatAllWraps() {
    var q = PlayQueue(); q.play(songs, startAt: 3)
    XCTAssertFalse(q.next())
    XCTAssertEqual(q.current?.id, "4")
    q.repeatMode = .all
    XCTAssertTrue(q.next())
    XCTAssertEqual(q.current?.id, "1")
  }

  func testRepeatOneOnlyOnNaturalEnd() {
    var q = PlayQueue(); q.play(songs); q.repeatMode = .one
    XCTAssertTrue(q.trackEnded()); XCTAssertEqual(q.current?.id, "1")
    XCTAssertTrue(q.next()); XCTAssertEqual(q.current?.id, "2")
  }

  func testShuffleKeepsCurrentFirstAndRestoresOrder() {
    var q = PlayQueue(); q.play(songs, startAt: 2)
    q.setShuffle(true)
    XCTAssertEqual(q.current?.id, "3"); XCTAssertEqual(q.index, 0)
    XCTAssertEqual(Set(q.songs.map(\.id)), Set(songs.map(\.id)))
    q.setShuffle(false)
    XCTAssertEqual(q.songs, songs); XCTAssertEqual(q.current?.id, "3")
  }

  func testPlayWhileShuffledStartsWithChosenTrack() {
    var q = PlayQueue(); q.setShuffle(true)
    q.play(songs, startAt: 2)
    XCTAssertTrue(q.isShuffled); XCTAssertEqual(q.current?.id, "3"); XCTAssertEqual(q.index, 0)
    q.setShuffle(false)
    XCTAssertEqual(q.songs, songs); XCTAssertEqual(q.index, 2)
  }

  func testAddNextAndPreviousBounds() {
    var q = PlayQueue(); q.play(songs, startAt: 0)
    q.addNext([Song(id: "x", title: "X")])
    XCTAssertEqual(q.songs[1].id, "x")
    XCTAssertFalse(q.previous())
    XCTAssertEqual(q.current?.id, "1")
  }

  func testDuplicatesRemoveAndMoveTrackTheCurrentEntry() {
    var q = PlayQueue(); q.play(songs, startAt: 1)
    q.append([songs[1]])
    XCTAssertEqual(Set(q.entries.map(\.key)).count, 5)
    q.remove(at: 4) // the duplicate, not the playing copy
    XCTAssertEqual(q.index, 1); XCTAssertEqual(q.entries.count, 4)
    q.move(from: 1, to: 3)
    XCTAssertEqual(q.index, 3); XCTAssertEqual(q.current?.id, "2")
    q.remove(at: 0)
    XCTAssertEqual(q.index, 2)
    q.remove(at: 2) // removing the last, current entry leaves nothing current
    XCTAssertNil(q.index)
  }

  func testClearKeepsModesAndCodableRoundTrip() throws {
    var q = PlayQueue(); q.play(songs, startAt: 2); q.repeatMode = .all
    let copy = try JSONDecoder().decode(PlayQueue.self, from: JSONEncoder().encode(q))
    XCTAssertEqual(copy, q); XCTAssertTrue(copy.isConsistent)
    q.clear()
    XCTAssertNil(q.current); XCTAssertEqual(q.repeatMode, .all)
  }

  func testEmptyQueueIsInert() {
    var q = PlayQueue(); q.play([])
    XCTAssertNil(q.current); XCTAssertFalse(q.next()); XCTAssertFalse(q.previous())
  }
}

final class LyricsTests: XCTestCase {
  func testLrcParsesMultiTimestampsOffsetAndWordTags() {
    let r = LRC.parse("[ti:x]\n[offset:+500]\n[00:02.50][00:10]Hello <00:03.00>world\n[00:01]First\n[99:99]bad")
    XCTAssertTrue(r.synced)
    XCTAssertEqual(r.lines.map(\.text), ["First", "Hello world", "Hello world"])
    XCTAssertEqual(r.lines.map(\.time), [0.5, 2.0, 9.5])
  }

  func testPlainTextCollapsesBlankRuns() {
    let r = LRC.parse("\n\nOne\n\n\nTwo\n\n")
    XCTAssertFalse(r.synced)
    XCTAssertEqual(r.lines.map(\.text), ["One", "", "Two"])
  }

  func testActiveLine() {
    let lines = [1.0, 2.0, 3.0].map { LyricLine(time: $0, text: "") }
    XCTAssertEqual(LRC.activeLine(lines, at: 0.5), -1)
    XCTAssertEqual(LRC.activeLine(lines, at: 2.0), 1)
    XCTAssertEqual(LRC.activeLine(lines, at: 9), 2)
  }

  func testMatchGuards() {
    let t = LyricsTrack(id: "1", title: "Song (feat. X)", artist: "Band", album: "LP", duration: 200)
    XCTAssertTrue(LyricsMatch.isMatch(t, trackName: "song", artistName: "band", albumName: nil, duration: 202))
    XCTAssertFalse(LyricsMatch.isMatch(t, trackName: "Song", artistName: "Band", albumName: nil, duration: 210))
    XCTAssertFalse(LyricsMatch.isMatch(t, trackName: "Song - Live", artistName: "Band", albumName: nil, duration: 200))
  }

  func testSpicySyllablesAndOverrun() {
    let body: [String: Any] = ["Type": "Syllable", "source": "spicy_lyrics", "UploadAttribution": ["Uploader": ["username": "u", "url": "javascript:x"]],
      "Content": [["Type": "Vocal", "OppositeAligned": true, "Lead": ["Syllables": [
        ["Text": "Hel", "StartTime": 1.0, "EndTime": 1.2, "IsPartOfWord": true], ["Text": "lo", "StartTime": 1.2, "EndTime": 1.5],
        ["Text": "you", "StartTime": 1.6, "EndTime": 20.0]]]]]]
    let l = SpicyLyrics.parse(body, trackDuration: 100)
    XCTAssertEqual(l?.lines.first?.text, "Hello you")
    XCTAssertEqual(l?.lines.first?.opposite, true)
    XCTAssertEqual(l?.attribution?.provider, "Spicy Lyrics")
    XCTAssertEqual(l?.attribution?.credits.first?.name, "u")
    XCTAssertNil(l?.attribution?.credits.first?.url)
    XCTAssertNil(SpicyLyrics.parse(body, trackDuration: 10)) // ends 10 s after the track: another recording
  }

  func testSpotifyIdParsing() {
    let id = "4uLU6hMCjMI75M1A2tKUQC"
    XCTAssertEqual(SpotifyLink.parseTrackID(id), id)
    XCTAssertEqual(SpotifyLink.parseTrackID("spotify:track:\(id)"), id)
    XCTAssertEqual(SpotifyLink.parseTrackID("https://open.spotify.com/intl-de/track/\(id)?si=1"), id)
    XCTAssertNil(SpotifyLink.parseTrackID("http://open.spotify.com/track/\(id)"))
    XCTAssertNil(SpotifyLink.parseTrackID("https://evil.com/track/\(id)"))
  }

  func testLyricsServerAddressCheck() {
    XCTAssertEqual(LyricsServer.check("https://Lyrics.Example.com/base/"), .ok("https://lyrics.example.com/base"))
    XCTAssertEqual(LyricsServer.check("http://localhost:8787"), .ok("http://localhost:8787"))
    if case .ok = LyricsServer.check("http://lyrics.example.com") { XCTFail("plain http must be refused") }
    if case .ok = LyricsServer.check("https://x.com/?a=1") { XCTFail("query must be refused") }
  }
}

final class SpotifyMatchTests: XCTestCase {
  private func c(_ id: String, _ name: String, artists: [String] = ["Band"], album: String = "LP", seconds: Double = 200, explicit: Bool = false, isrc: String = "") -> SpotifyCandidate {
    SpotifyCandidate(id: String(repeating: id, count: 22), name: name, artists: artists, album: album, durationMs: seconds * 1000, explicit: explicit, isrc: isrc)
  }
  private let track = LyricsTrack(id: "1", title: "Song", artist: "Band", album: "LP", duration: 200)

  func testConfidentMatch() {
    guard case .matched(let m, _) = SpotifyMatch.resolve(track, [c("a", "Song")]) else { return XCTFail() }
    XCTAssertEqual(m.name, "Song")
  }

  func testLiveVersionIsRejected() {
    XCTAssertEqual(SpotifyMatch.resolve(track, [c("a", "Song - Live")]), .none)
  }

  func testIsrcWinsOverSpelling() {
    var t = track; t.isrc = ["USRC17607839"]
    guard case .matched = SpotifyMatch.resolve(t, [c("a", "Canción", artists: ["Banda"], isrc: "USRC17607839")]) else { return XCTFail() }
  }

  func testCloseRivalsAreAmbiguous() {
    let r = SpotifyMatch.resolve(track, [c("a", "Song", album: "Other"), c("b", "Song", album: "Other", seconds: 203)])
    if case .matched = r { XCTFail("a rival recording should block the automatic match") }
  }

  func testFold() {
    XCTAssertEqual(SpotifyMatch.fold("Beyoncé & Jay-Z: Don't"), "beyonce and jay z dont")
  }
}

final class PaletteTests: XCTestCase {
  func testRedCoverGivesRedAccentWithReadableText() {
    let p = ArtworkPalette.derive((0..<64).flatMap { _ in [200, 30, 30, 255] as [UInt8] })
    XCTAssertNotNil(p.hue)
    XCTAssertGreaterThanOrEqual(ColorMath.contrast(p.accent, p.hover), 4.5)
    XCTAssertGreaterThanOrEqual(ColorMath.contrast("#ffffff", p.accentFill), 4.5)
  }

  func testGrayCoverHasNoHue() {
    XCTAssertNil(ArtworkPalette.derive((0..<64).flatMap { _ in [128, 128, 128, 255] as [UInt8] }).hue)
  }
}
