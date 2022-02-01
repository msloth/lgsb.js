# lgsb.js

This is a library for interfacing LG Soundbars. I've only tested on my own soundbar, the LG SP8YA, but it seems SN9YG and others may work too.

## Quick-start

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

## Rationale

To programmatically interface the Soundbar, instead of going via the LG Soundbar app. This allows chaining actions, and flexibility (eg via Home Assistant, or a Telegram bot).

Example - a controller that turns on and off "Night mode" on schedule, instead of having to manually go via the LG app twice a day.

This library will automatically handle the network connection to the speaker, so no explicit connect/disconnect/reconnect is required by the caller.

## Requirements

* The Soundbar must have power and initialized with access to local network
* Both Soundbar and controller must be on the same network.
* The IP-address of the Soundbar must be known.
* It does not need to be "on" as in the on-device display showing something. It is always on and listening for input.

## Limitations

This library does not do Soundbar network discovery. Suggested workaround is that you assign the Soundbar a fixed IP on the local network.

The input handling (data from soundbar) is a bit fragile and does little error checking.

This library is unsupported and no responsibility is taken for any damage use of this library brings, including but not limited to loss of warranty. You are on your own and you take full responsibility yourself for what you do, even if (_especially_ if) you don't know what you do. That said, I don't think anything in this library can damage or void warranty.

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
