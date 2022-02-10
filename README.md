# lgsb.js

This is a library for interfacing LG Soundbars.

## Hardware

This library only works with LG Soundsystems. Unclear exactly which ones, but feel free to drop a comment or PR if you've tested this on other hardware.

Known working with LG SP8YA, seems SN9YG works too from reading comments on others using the other library (temescal).

## Usage

### Basic example

```
const lg_soundbar = require('lgsb.js');
let lgsb = new lg_soundbar("192.168.1.135");

lgsb.get_nightmode((enabled) => {
  console.log(`Night mode enabled? ${enabled}`);
  if (enabled) {
    console.log(`Setting volume to 10`);
    lgsb.set_volume(10, () => {});
  }
});
```

### Change volume

Volume can be set in absolute numbers (eg "set volume to 10") or in relative numbers (eg "set volume -4"). It will cap downwards at 0.

```
const lg_soundbar = require('lgsb.js');
let lgsb = new lg_soundbar("192.168.1.135");

// all these are valid uses with a relative volume level:
lgsb.set_volume("+6", (ret) => {});
lgsb.set_volume("-2", (ret) => {});
lgsb.set_volume(-4, (ret) => {});

// all these are valid uses with an absolute volume level:
lgsb.set_volume(5, (ret) => {});
lgsb.set_volume(0, (ret) => {});
lgsb.set_volume("10", (ret) => {});
```

### Latency and updates

The library maintains a connection to the speaker, in order to communicate with it. This connection is automatically set up and teared down without the need to explicitly call anything.

The purpose of maintaining it is to lower latency and reduce traffic, since calls are chained without TCP handshaking for each call.

This connection is maintained by default 5000 ms since last traffic across it. It can be reduced (eg when used in scripts, you don't want to wait five seconds for it to time out) by two methods: either explicitly call `_disconnect()`, or lower the timeout value.

```
const lg_soundbar = require('lgsb.js');
let lgsb = new lg_soundbar("192.168.1.135");

// lower timeout value for the TCP connection
lgsb.auto_disconnect_timeout = 100; // ms
// ....
```

Or, disconnect explicitly when done:

```
let lgsb = new lg_soundbar("192.168.1.135");

lgsb.get_basic_info((ret) => {
  console.log(ret);
  lgsb._disconnect();
});
/*---------------------------------------------------------------------------*/
```

A third option is to have the library always disconnect after receiving data. This is experimental still. Positive: ensures we're always disconnected after we're done (no long wait after the last transmission), and values are always correct. Negative: adds latency.

```
let lgsb = new lg_soundbar("192.168.1.135");

// disconnect after each answer
lgsb.always_disconnect = true;

lgsb.get_basic_info((ret) => {
  console.log(ret);
  lgsb._disconnect();
});
/*---------------------------------------------------------------------------*/
```

### Changing input

Input is selected from a list of possible inputs. Not all are supported on every sound system. Here's an example to set the speaker in a specified state:

```
let lgsb = new lg_soundbar("192.168.1.135");

lgsb.set_input("hdmi", () => {
  lgsb.set_volume(15, (ret) => {
    lgsb.set_night_mode(false, (ret) => {
      lgsb._disconnect();
    });
  });
});
```

### Other functionality

Lacking full documentation yet, feel free to look at what functions the class exports.

## Rationale

To programmatically interface the Soundbar, instead of going via the LG Soundbar app. This allows chaining actions, and flexibility (eg via Home Assistant, or a Telegram bot).

Example - a controller that turns on and off "Night mode" on schedule, instead of having to manually go via the LG app twice a day.

This library will automatically handle the network connection to the speaker, so no explicit connect/disconnect/reconnect is required by the caller.

## Requirements

* The Soundbar must have power and initialized with access to local network
* Both Soundbar and controller must be on the same network.
* The IP-address of the Soundbar must be known.
* It does not need to be "on" as in the on-device display showing something. It is always on and listening for input.

## Limitations and liability

This library does not do Soundbar network discovery. Suggested workaround is that you assign the Soundbar a fixed IP on the local network.

The input handling (data from soundbar) is a bit fragile and does little error checking.

This library is unsupported and no responsibility is taken for any damage use of this library brings, including but not limited to loss of warranty. You are on your own and you take full responsibility yourself for what you do, even if (_especially_ if) you don't know what you do. That said, I don't think anything in this library can damage or void warranty.

## TODOs

Would be nice to be able to set the speaker into a mode without having to chain several calls or knowing the internals. Eg,

```
let lgsb = new lg_soundbar("192.168.1.135");

let state = {
  nightmode: false,
  volume: 10,
  input: "hdmi",
  eq: "standard"
};

lgsb.set_state(state, () => {
  lgsb._disconnect();
});
```

More todos are in the .js-file.

## About the Soundbar interfaces

The Soundbar offers several services: local control, Spotify connect, Airplay. The LG app uses TCP port 9741 for query-response comms with the Soundbar. This is also the way this library controls the Soundbar.

```
result of TCP port scan of the soundbar (LG SP8YA)

sudo nmap -sV -p 1-65535 192.168.1.135
Nmap scan report for 192.168.1.135
Not shown: 65521 closed tcp ports (reset)
PORT      STATE SERVICE          VERSION
7000/tcp  open  rtsp
8008/tcp  open  http?
8009/tcp  open  ssl/ajp13?
8012/tcp  open  unknown
8443/tcp  open  ssl/https-alt?
9000/tcp  open  ssl/cslistener?
9741/tcp  open  unknown
9876/tcp  open  sd?
10001/tcp open  ssl/scp-config?
10101/tcp open  ssl/ezmeeting-2?
50122/tcp open  unknown
55442/tcp open  nagios-nsca      Nagios NSCA
55443/tcp open  ssl/unknown
55556/tcp open  unknown
```

Using a packet sniffer on the phone when using the app, the traffic over TCP:9741 can easily be caught and inspected.

## ACKs

This library is built from https://github.com/google/python-temescal which is Google-hosted, but is not in any way affiliated, associated, or endorsed by Google.
