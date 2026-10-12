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

  func testSyncedLyricsAppliesOffsetAndPrefersSynced() async throws {
    let json = #"{"subsonic-response":{"status":"ok","version":"1.16.1","lyricsList":{"structuredLyrics":[{"synced":false,"line":[{"value":"plain"}]},{"synced":true,"offset":500,"line":[{"start":1000,"value":"one"},{"start":2000,"value":"two"}]}]}}}"#
    let lines = try await client(json).lyrics(songId: "s")
    XCTAssertEqual(lines, [LyricLine(start: 1.5, text: "one"), LyricLine(start: 2.5, text: "two")])
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

  func testAddNextAndPreviousBounds() {
    var q = PlayQueue(); q.play(songs, startAt: 0)
    q.addNext(Song(id: "x", title: "X"))
    XCTAssertEqual(q.songs[1].id, "x")
    XCTAssertFalse(q.previous())
    XCTAssertEqual(q.current?.id, "1")
  }

  func testEmptyQueueIsInert() {
    var q = PlayQueue(); q.play([])
    XCTAssertNil(q.current); XCTAssertFalse(q.next()); XCTAssertFalse(q.previous())
  }
}
