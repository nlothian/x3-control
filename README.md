# x3-control

Control a **Kaiser Baas X3** action camera from a computer, now that the
official app is gone. Includes a command-line tool, a REST API and a web UI
with live view, settings, and photo/video browsing with in-browser playback.

- No npm dependencies. Needs Node 18+.
- [ffmpeg](https://ffmpeg.org/) is needed for live view in the browser, video
  playback and thumbnails (`brew install ffmpeg`, `apt install ffmpeg`, …).
  Everything else works without it.

Not affiliated with Kaiser Baas. It works by talking to the camera's built-in
web server; use it at your own risk (especially the Wi-Fi client mode below).

## Quick start

1. Turn on the camera's Wi-Fi and join its hotspot (`KB-X3` by default) from
   your computer. The camera is then at `192.72.1.1`.
2. Clone this repository, then run:

```bash
node cli.js status
npm start             # web UI on http://localhost:3000
```

The camera is **found automatically**, both on its hotspot and on your home
network (see below). To use a fixed address instead, pass `--host <ip>` to the
CLI or set `X3_HOST=<ip>` for both. `node cli.js discover` lists every camera
it can find.

## Command line

```bash
node cli.js status                 # mode and recording state
node cli.js info                   # battery, space left
node cli.js photo
node cli.js record start           # or: record stop
node cli.js files --all            # videos (add --photos for photos)
node cli.js download --all --dir ~/Movies/X3
node cli.js download --all --photos --dir ~/Pictures/X3
node cli.js options                # every setting and the values it accepts
node cli.js setting VideoRes 1080P60
node cli.js clock                  # set the camera clock to this computer's time
node cli.js live                   # print the RTSP live-view URL (open in VLC)
node cli.js wifi                   # hotspot / client-mode configuration
node cli.js wifi hotspot-mode --yes            # switch back to the camera's own hotspot
node cli.js wifi client-mode --ssid "MyHomeWiFi" --password --yes   # join your network
node cli.js help                   # everything else, including raw get/set
```

## Web UI and REST API

`npm start` serves the web UI: live view, photo/record buttons, a Videos /
Photos browser with in-browser playback, and Settings with a **Camera** tab
(menu settings) and a **Wi-Fi** tab. The Wi-Fi tab shows the current mode,
switches between hotspot and client mode, changes the hotspot name and
password, and adds, edits or removes the saved networks the camera joins in
client mode. Passwords are write-only: the page only shows whether one is set.
When you switch to hotspot mode the server starts using `192.72.1.1` and
remembers the camera's address on your network for switching back.

The server has **no authentication** and listens on all interfaces, so anyone
on your network who can reach it can control the camera and change its Wi-Fi
settings. Only run it on a network you trust.

API:

| Method | Path | Body / query |
|---|---|---|
| GET | `/api/status` | mode and recording state |
| GET | `/api/info` | battery %, photos / recording seconds left |
| GET | `/api/settings` | current menu settings |
| GET | `/api/settings/meta` | each setting with label, current value and allowed `options` (or `free` / `readOnly`) |
| PUT | `/api/settings/:name` | `{"value": "1080P60"}`: waits until it sticks; 400 if the camera rejects it |
| GET | `/api/get?property=Net.*` | raw read |
| POST | `/api/set` | `{"property": "...", "value": "..."}`: raw write |
| POST | `/api/photo` | |
| POST | `/api/record/start` · `/stop` · `/toggle` | |
| POST | `/api/clock` | |
| GET | `/api/files` | `?type=video` (default) or `?type=photo`; `&all`, or `&from=0&count=16` |
| DELETE | `/api/files?path=/SD/Video/…` | |
| GET | `/api/wifi` | `mode` (`hotspot` / `client` / `mixed`), hotspot, saved networks (`hasKey`, never passwords), `cameraHost` |
| PUT | `/api/wifi/hotspot` | `{"ssid": "...", "password": "..."}`: either may be omitted |
| PUT | `/api/wifi/networks/:slot` | `{"ssid": "...", "password": "...", "encType": "AES"}` for slot 1–8; omit `password` to keep it. Read back before returning. |
| DELETE | `/api/wifi/networks/:slot` | empty a saved-network slot |
| POST | `/api/wifi/hotspot-mode` | switch to the camera's hotspot (it leaves your network) |
| POST | `/api/wifi/client-mode` | switch to client mode using the saved networks (turns the hotspot off) |
| PUT | `/api/camera-host` | `{"host": "192.168.1.50"}` for a fixed address, or `{"host": "auto"}` to find it automatically |
| POST | `/api/discover` | search the hotspot address and local network; uses the first camera found |
| GET | `/media?path=/SD/…[&download]` | the original file |
| GET | `/play?path=/SD/Video/….MOV` | browser-playable MP4 (H.264 + AAC), with Range support for seeking |
| GET | `/thumb?path=/SD/…` | 320px-wide JPEG thumbnail of a video or photo |
| GET | `/live.mjpeg` | live view as MJPEG (converted from the camera's RTSP stream) |

**Playback and thumbnails.** The X3 records H.264 video with IMA ADPCM audio,
which browsers won't play, so `/play` copies the video and converts only the
audio. Results are cached in `cache/` (or `X3_CACHE_DIR`), so each file is only
converted once. The first play has to wait for the whole file to come off the
camera, which sends about 1.5 MB/s over Wi-Fi (a 100 MB clip takes about 75
seconds). Delete `cache/` to reclaim space.

## Putting the camera on your home Wi-Fi

The firmware has a hidden **client ("station") mode**, which lets the camera
join your network instead of running its own hotspot. The original app never
used it.

> **Read the recovery section before trying this.** The radio can't run the
> hotspot and client mode at the same time, so the hotspot has to be switched
> off. If the camera then can't join your network, you can't reach it, and the
> camera's factory reset does *not* bring the hotspot back.

While connected to the camera's hotspot:

```bash
node cli.js wifi                   # show the current configuration
node cli.js wifi test-write        # harmless: checks Wi-Fi settings can be written
node cli.js wifi client-mode --ssid "MyHomeWiFi" --password --yes
```

`--password` with no value prompts for it, so it stays out of your shell
history. Without `--yes` the command only explains what it will do. It refuses
passwords the firmware can't store, and it only switches after reading the
network name and password back from the camera and confirming they match. The
camera's Wi-Fi then restarts. Give it about two minutes (power-cycle it if needed), then
find it in your router's list of connected devices.

- **It gets a new MAC address and IP every time it joins.** Its Wi-Fi module
  uses `00:e0:4c:00:00:xx`, and only the last byte changes. The router gives
  it a fresh address each time, so a DHCP reservation doesn't help, and the
  `00:0E:53:…` address and IP that `Net.*` report aren't used at all.
- **You don't need to know the address:** the CLI and server find it
  automatically. They check the hotspot address and any `00:e0:4c:00:00:*`
  entries in your computer's ARP cache, then ask every address on your local
  network(s) for the camera's firmware version. It doesn't answer SSDP/UPnP
  discovery. The server searches again whenever the camera stops answering,
  and the web UI has a **Find camera** button.
- To switch back to the camera's own hotspot, run
  `node cli.js --host <ip> wifi hotspot-mode --yes`, then join `KB-X3` again.
  Your network stays saved, so `client-mode` switches back.
- The network must be on **2.4 GHz** with **WPA2 (AES)** or WPA (TKIP). These
  chips can't use 5 GHz.
- Passwords can be at most **35 characters** and **can't contain `&`**. The
  firmware cuts the value at `&` however it's encoded. Check yours with
  `node cli.js wifi key-test`.

This follows the same sequence as
[vzaliva/dashcam-browse](https://github.com/vzaliva/dashcam-browse), which
does this for another camera with the same chipset.

### If the camera doesn't show up

The camera keeps trying the saved network every time it starts, so the way back
in is to give it that network:

- Make sure a 2.4 GHz network with exactly that name and password is in range.
  A phone hotspot renamed to match works too: on an iPhone, set the phone's
  name and hotspot password, and turn on *Maximise Compatibility* for 2.4 GHz.
- Once you can reach it, turn the hotspot back on with
  `node cli.js --host <ip> wifi hotspot-mode --yes`.
- Check your router's DHCP client list for a recent `00:e0:4c:00:00:…`
  entry: that's the camera joining, even if it didn't stay.
- To check whether it's trying at all on a Mac, capture on your 2.4 GHz channel
  with `sudo /usr/libexec/airportd en0 sniff 2g<channel>/20` (Ctrl-C to stop;
  the capture goes to `/tmp`), or with Wireless Diagnostics → Window → Sniffer.
  Then look for probe requests from a `00:e0:4c:…` address.

If client mode doesn't suit you, use a Raspberry Pi (or any machine with two
network interfaces) as a bridge instead. One interface joins `KB-X3`, the other
sits on your LAN and runs `npm start`.

## How the camera works

The X3 is built on an **AIT (Alpha Imaging Technology)** chipset, running the
firmware's "CarDV" web server. Everything is plain HTTP GET requests.

| What | How |
|---|---|
| Read settings | `GET /cgi-bin/Config.cgi?action=get&property=Camera.Menu.*` → `0\nOK\nKey=Value…` |
| Change a setting | `action=set&property=<Name>&value=<v>`. Returns `0 OK`, or `701 Illegal Parameter` for an unsupported value. Applied with a lag, so re-read a few times to confirm. `VideoRes`/`ImageRes` are written as `Videores`/`Imageres`. |
| Record (toggle) | `action=set&property=Video&value=record` |
| Photo | `action=set&property=Video&value=capture`. Only saves a photo while the live stream is running; the web UI starts it in the background. |
| Mode / record state | `action=get&property=Camera.Preview.MJPEG.status.*` |
| Battery, space left | `action=get&property=Camera.*`. `Camera.Battery.Level` is 0/25/50/75/100 and dips under load; it reads 200 while charging. |
| List files | `action=dir&property=DCIM&format=all&count=16&from=0` (XML) for videos; `property=Photo` for photos (case-sensitive; anything else lists videos) |
| Download | `GET /SD/Video/<file>.MOV`, `GET /SD/Photo/<file>.JPG` (Range supported). The camera's `/thumb/…` returns 503 outside playback mode. |
| Delete | `action=del&property=$SD$Video$<file>.MOV` (`/` → `$`) |
| Set clock | `action=set&property=TimeSettings&value=YYYY$MM$DD$hh$mm$ss` |
| Wi-Fi config | `action=get&property=Net.*` |
| Apply Wi-Fi changes | `action=set&property=Net&value=reset` |
| Live view | `rtsp://<camera>/liveRTSP/av4` (H.264 640×360). There's no HTTP/MJPEG stream. |

- **One request at a time.** The camera's web server handles a single request
  at a time. The library queues requests; if you use curl by hand, don't run
  requests in parallel.
- **Not the old app's protocol.** The `KB+X3` Android app found online targets a
  different (Novatek, `192.168.1.254`) firmware and doesn't work with this
  camera.
- **Allowed setting values.** The values in
  [lib/settings-meta.js](lib/settings-meta.js) were found by probing an X3
  (firmware `KBX3`). `X3Camera.discoverOptions(name, candidates)` tries each
  candidate, keeps the ones the camera doesn't reject, and restores the
  original. Only run it while the camera isn't recording. Other firmware
  versions may accept different values.

## Development

```bash
npm test                           # tests against a mock camera built from real responses
npm run mock                       # fake camera on :8080
X3_HOST=localhost:8080 node cli.js status
```

## License

[MIT](LICENSE)
