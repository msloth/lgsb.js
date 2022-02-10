/*---------------------------------------------------------------------------*/
// This is a library for interfacing LG Soundbars.
// 
// This library will automatically handle the connection to the speaker,
// automatically maintain/close/reconnect as needed.
/*---------------------------------------------------------------------------*/
// TODO:
// 
// * examples
// * fix disconnect, doesn't immediately shut down all (timer left?) 
// * autodiscovery if IP isn't known (does not answer SSDP it seems)
// * if waking up soundbar, after it responding, it sends something more, that
//      the decrypt breaks on. What is that?
// * test what happens if soundbar is not on network
// * handle race condition when two calls are made, yet the first is not yet
//   connected, two system calls for socket is made -> crash
//    -> change flag to eg "connected_or_connecting"
//    
// * better match up request->answer->callback
// * perhaps divide up, no queue but instead one full TCP up-send-down per command
//    --values aren't updated until TCP reconnected it seems.
//      a set-get (ie write, then immediately read) of a value, will read the
//      value as it was _before_ the write, not what was written.
/*---------------------------------------------------------------------------*/
// This library is built upon https://github.com/google/python-temescal which
// is Google-hosted, but is not in any way affiliated, associated, or endorsed
// by Google. Temescal documented the packet format and encryption key+iv.  
// 
// For https://github.com/google/python-temescal :
// 
// # Copyright 2018 Google LLC
// #
// # Licensed under the Apache License, Version 2.0 (the "License");
// # you may not use this file except in compliance with the License.
// # You may obtain a copy of the License at
// #
// #    https://www.apache.org/licenses/LICENSE-2.0
// #
// # Unless required by applicable law or agreed to in writing, software
// # distributed under the License is distributed on an "AS IS" BASIS,
// # WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// # See the License for the specific language governing permissions and
// # limitations under the License.
/*---------------------------------------------------------------------------*/
const net = require('net');
const crypto = require("crypto");

const log = require('loglevel');
/*---------------------------------------------------------------------------*/
const running_as_script = (require.main === module);
if (running_as_script) {
  log.setLevel("debug"); // silent, error, warn, info, debug, trace
} else {
  log.setLevel("silent"); // silent, error, warn, info, debug, trace
}
/*---------------------------------------------------------------------------*/
// cipher
const ciphertype = 'aes-256-cbc';
const iv = "'%^Ur7gy$~t+f)%@";
const key = "T^&*J%^7tr~4^%^&I(o%^!jIJ__+a0 k";
/*---------------------------------------------------------------------------*/
// List of equalizers.
const equalizers = ["Standard",               // 0
                    "Bass",                   // 1
                    "Flat",                   // 2
                    "Boost",                  // 3
                    "Treble and Bass",        // 4
                    "User",                   // 5
                    "Music",                  // 6
                    "Cinema",                 // 7
                    "Night",                  // 8
                    "News",                   // 9
                    "Voice",                  // 10
                    "ia_sound",               // 11
                    "Adaptive Sound Control", // 12
                    "Movie",                  // 13
                    "Bass Blast",             // 14
                    "Dolby Atmos",            // 15
                    "DTS Virtual X",          // 16
                    "Bass Boost Plus",        // 17
                    "DTS X",];                // 18
/*---------------------------------------------------------------------------*/
// List of possible inputs. Note that the speaker doesn't necessarily support all.
// Also note that, to get to E-ARC, you don't set input to "E-ARC" (20), instead
// input 4 ("Optical") is used (at least on SP8YA).

const inputs = ["Wifi",                       // 0
                "Bluetooth",                  // 1
                "Portable",                   // 2
                "Aux",                        // 3
                "Optical",                    // 4 <- for e-arc when set'ting
                "CP",                         // 5
                "HDMI",                       // 6
                "ARC",                        // 7
                "Spotify",                    // 8
                "Optical2",                   // 9
                "HDMI2",                      // 10
                "HDMI3",                      // 11
                "LG TV",                      // 12
                "Mic",                        // 13
                "Chromecast",                 // 14
                "Optical/HDMI ARC",           // 15
                "LG Optical",                 // 16
                "FM",                         // 17
                "USB",                        // 18
                "USB2",                       // 19
                "E-ARC"];                     // 20 <- when reading (get)
/*---------------------------------------------------------------------------*/
// "hack" to get the function name, which simplifies logging statements.
function functionname() {
  return functionname.caller.name
}
/*---------------------------------------------------------------------------*/
let _encrypt = function(data) {
  let encrypter = crypto.createCipheriv(ciphertype, key, iv);
  let encrypted = encrypter.update(data, "utf8", "binary") + encrypter.final("binary");
  return encrypted;
}
/*---------------------------------------------------------------------------*/
let _decrypt = function(data) {
  try {
    let decrypter = crypto.createDecipheriv(ciphertype, key, iv);
    let decrypted = decrypter.update(data, "binary") + decrypter.final("binary");
    decrypted = decrypted.toString('utf8');
    return decrypted;
  } catch(error) {
    log.error(`lgsb.js: failed decrypting: ${data}`);
    log.error(error);
    return undefined;
  }
}
/*---------------------------------------------------------------------------*/
// every packet to/from the Soundbar has a 5B header, then the JSON data in
// AES-CBC-256bit-encrypted form.

let _create_packet = function(data) {
  let output = data;
  if (typeof(output) !== "string") {
    output = JSON.stringify(output);
  }

  // encrypt data, create header, mash them together
  let encrypted_payload = Buffer.from(_encrypt(output), "binary");
  let header = Buffer.from([0x10, 0x00, 0x00, 0x00, encrypted_payload.length]);
  let payload = [header, encrypted_payload];
  payload = Buffer.concat(payload);
  return payload;
}
/*---------------------------------------------------------------------------*/






/*---------------------------------------------------------------------------*/
// this function can and will be repeatedly called. It will one by one unload
// the command queue to the device.
// If not connected, it will first connect.
// If no commands in queue, it will do nothing. An timer will expire, which will
// terminate the TCP connection if idle too long.

let _send_to_device = function() {
  // sanity check: are we even needed?
  if (this.sendqueue.length === 0) {
    log.log(`lgsb.js: send, but queue at 0 so returning; letting live auto for a few seconds`);
    return;
  }

  // sanity check: are we currently waiting for an connect/answer?
  if (this.current_send) {
    log.log(`lgsb.js: send, but already current, ie waiting for answer`);
    return;
  }

  log.log(`lgsb.js: Sending... Queue at ${this.sendqueue.length}`);
  if (!this.is_connected) {
    log.warn(`lgsb.js: Send, but not connected yet.`);
    this._connect_to_device();

  } else {
    if (!this.current_send) {
      // pick next send from the queue, when we recieve an answer, we will
      // invoke the corresponding callback and clear this.current_send
      this.current_send = this.sendqueue.shift();
    }

    // send over network
    log.debug(`lgsb.js: current command: `);
    log.debug(this.current_send.command);
    let payload = this._create_packet(this.current_send.command);
    this.tcpclient.write(payload);

    // restart timer
    if (this.auto_disconnect_timer) {
      clearTimeout(this.auto_disconnect_timer);
    }
    this.auto_disconnect_timer = 
      setTimeout(this._disconnect.bind(this), this.auto_disconnect_timeout);

  }
}
/*---------------------------------------------------------------------------*/




/*---------------------------------------------------------------------------*/
// Terminate the TCP connection, mostly from a timer if the connection is idle
let _disconnect = function() {
  log.log(`lgsb.js: Closing connection`);

  // stop timer if running
  if (this.auto_disconnect_timer) {
    clearTimeout(this.auto_disconnect_timer);
    this.auto_disconnect_timer = undefined;
  }

  this.tcpclient.destroy();
}
/*---------------------------------------------------------------------------*/
let _connect_to_device = function() {
  if (this.is_connected) {
    log.log(`lgsb.js: Connect, but already connected`);
    return;
  }

  log.log(`lgsb.js: Connecting... Queue at ${this.sendqueue.length}`);
  this.tcpclient.connect(this.tcpport, this.ipaddr, _tcp_opened.bind(this));
}
/*---------------------------------------------------------------------------*/
let _tcp_opened = function() {
  log.log(`lgsb.js: TCP Connected... Queue at ${this.sendqueue.length}`);
  this.is_connected = true;
  this.auto_disconnect_timer = 
      setTimeout(this._disconnect.bind(this), this.auto_disconnect_timeout);

  // start/keep sending
  this._send_to_device();
}
/*---------------------------------------------------------------------------*/
let _tcp_error = function() {
  log.log(`lgsb.js: TCP error... Queue at ${this.sendqueue.length}`);
  this.is_connected = false;

  // start/keep sending
  this._send_to_device();
}
/*---------------------------------------------------------------------------*/
// Data received from the Soundbar
// Note: needs hardening
let _tcp_data = function(data) {
  if (data[0] != 0x10) {
    log.warn(`lgsb.js: warning: rx header magic not ok`);
  }

  let rxed = _decrypt(data.slice(5));
  if (rxed != undefined) {
    try {
      rxed = JSON.parse(rxed);
    } catch(error) {
      log.error(`lgsb.js: failed parsing received as JSON: ${rxed}`);
      rxed = undefined;
    }
  }

  if (this.current_send) {
    // note: if we failed decrypt or parse, answer is undefined
    log.log(`lgsb.js: current send exists`);
    if (this.current_send.callback) {
      this.current_send.callback(rxed);
    }

    // clear it, so we know to pick the next queue if such
    this.current_send = undefined;
  }

  // start/keep sending
  // XXX Here, we can either keep on sending OR disconnect and let the "closed"-
  // handler reconnect (if more in queue).
  // Keep on -  lower latency
  //            probably more threadsafe
  //            "Get"s aren't necessarily accurate (if written during same conn)
  // Disconnect - reconnect timer adds latency
  //              "Get"s are always accurate
  this._send_to_device(); // keep on
  // this._disconnect(); // disconnect
}
/*---------------------------------------------------------------------------*/
let _tcp_closed = function() {
  log.log('lgsb.js: TCP Connection closed');
  this.is_connected = false;

  // stop timer if running; if anything restarts the connection, the timer will
  // be set up again there
  if (this.auto_disconnect_timer) {
    clearTimeout(this.auto_disconnect_timer);
    this.auto_disconnect_timer = undefined;
  }

  // if we should reconnect, set that up
  if (this.sendqueue.length > 0) {
    log.warn(`lgsb.js: TCP closed but queue > 0, setting reconnect timer`);
    this.reconnect_timer = setTimeout(this._connect_to_device, 1000);
  }
}
/*---------------------------------------------------------------------------*/












/*---------------------------------------------------------------------------*/
let _get = function(getwhat, callback, logname) {
  log.log(`${logname}`);
  this.sendqueue.push({
    command: {"cmd": "get", "msg": getwhat},
    callback: callback});

  this._send_to_device();
}
/*---------------------------------------------------------------------------*/
let get_eq = function(callback) {
  this._get("EQ_VIEW_INFO", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_play = function(callback) {
  this._get("PLAY_INFO", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_func = function(callback) {
  this._get("FUNC_VIEW_INFO", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_settings = function(callback) {
  this._get("SETTING_VIEW_INFO", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_product_info = function(callback) {
  this._get("PRODUCT_INFO", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_c4a_info = function(callback) {
  this._get("C4A_SETTING_INFO", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_radio_info = function(callback) {
  this._get("RADIO_VIEW_INFO", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_ap_info = function(callback) {
  this._get("SHARE_AP_INFO", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_update_info = function(callback) {
  this._get("UPDATE_VIEW_INFO", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_build_info = function(callback) {
  this._get("BUILD_INFO_DEV", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_option_info = function(callback) {
  this._get("OPTION_INFO_DEV", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_mac_info = function(callback) {
  this._get("MAC_INFO_DEV", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_mem_mon_info = function(callback) {
  this._get("MEM_MON_DEV", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_test_info = function(callback) {
  this._get("TEST_DEV", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let _set_view_info = function(setwhat, callback, logname) {
  log.log(`lgsb.js: _set_view_info running ${logname}`);
  this.sendqueue.push({
    command: {"cmd": "set", "data": setwhat, "msg": "SETTING_VIEW_INFO"},
    callback: callback});

  this._send_to_device();
}
/*---------------------------------------------------------------------------*/
let _set = function(category, setwhat, callback, logname) {
  log.log(`lgsb.js: _set running ${logname}`);
  this.sendqueue.push({
    command: {"cmd": "set", "data": setwhat, "msg": category},
    callback: callback});

  this._send_to_device();
}
/*---------------------------------------------------------------------------*/
let set_night_mode = function(enable, callback) {
  this._set_view_info({"b_night_time": enable}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_avc = function(enable, callback) {
  this._set_view_info({"b_auto_vol": enable}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_drc = function(enable, callback) {
  this._set_view_info({"b_drc": enable}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_neuralx = function(enable, callback) {
  this._set_view_info({"b_neuralx": enable}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_av_sync = function(value, callback) {
  this._set_view_info({"i_av_sync": value}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_woofer_level = function(value, callback) {
  this._set_view_info({"i_woofer_level": value}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_rear_control = function(enable, callback) {
  this._set_view_info({"b_rear": enable}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_rear_level = function(value, callback) {
  this._set_view_info({"i_rear_level": value}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_top_level = function(value, callback) {
  this._set_view_info({"i_top_level": value}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_center_level = function(value, callback) {
  this._set_view_info({"i_center_level": value}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_tv_remote = function(enable, callback) {
  this._set_view_info({"b_tv_remote": enable}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_auto_power = function(enable, callback) {
  this._set_view_info({"b_auto_power": enable}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_auto_display = function(enable, callback) {
  this._set_view_info({"b_auto_display": enable}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_bt_standby = function(enable, callback) {
  this._set_view_info({"b_bt_standby": enable}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_bt_restrict = function(enable, callback) {
  this._set_view_info({"b_conn_bt_limit": enable}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_sleep_time = function(value, callback) {
  this._set_view_info({"i_sleep_time": value}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_name = function(name, callback) {
  this._set_view_info({"s_user_name": name}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_eq_raw = function(eq, callback) {
  this._set("EQ_VIEW_INFO" ,{"i_curr_eq": eq}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_eq = function(eq, callback) {
  // find the number that the soundbar may accept
  for (let i = 0; i < equalizers.length; i++) {
    if (eq.toLowerCase() == equalizers[i].toLowerCase()) {
      log.info(`lgsb.js: Set equalizer to ${equalizers[i]}`);
      this.set_eq_raw(i, callback);
    }
  }

  // no match found
  log.warn(`lgsb.js: no eq match found for ${eq}`);
}
/*---------------------------------------------------------------------------*/
// not used directly, instead call set_input with string
let set_input_raw = function(value, callback) {
  this._set("FUNC_VIEW_INFO" ,{"i_curr_func": value}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
// eg set_input("hdmi", ...). Case insensitive
// note that not all are accepted; eg e-arc was not, instead on SP8YA
// input Optical (4) was used, then the tv+soundbar made a handshake-> earc
let set_input = function(input, callback) {

  // find the number that the soundbar may accept
  for (let i = 0; i < inputs.length; i++) {
    if (input.toLowerCase() == inputs[i].toLowerCase()) {
      log.info(`lgsb.js: Set input to ${inputs[i]}`);
      this.set_input_raw(i, callback);
    }
  }

  // no match found
  log.warn(`lgsb.js: no input match found for ${input}`);
}
/*---------------------------------------------------------------------------*/
let set_volume = function(value, callback) {
  let parsed = 0;
  let relative_vol = false;
  let negative = false;
  let newvol = 0;

  // volume is absolute if:
  //    is string && string does not contain "-" or "+"
  //    number && number > 0
  // otherwise relative.
  if (typeof value === "string") {
    if (value.indexOf("+") === 0 || value.indexOf("-") === 0) {
      // handle "+5", "-5"
      relative_vol = true;
      if (value.indexOf("-") === 0) {
        negative = true;
      }
      parsed = parseInt(value.replace("-","").replace("+",""), 10);
    } else {
      // handle "5"
      relative_vol = false;
      parsed = parseInt(value, 10);
    }

    if (isNaN(parsed)) {
      // not ok parsed, bail out
      log.warn(`lgsb.js: error parsing volume as string from input, bailing. Input: ${value}`);
      if (callback) {
        callback(undefined);
      }
      return;
    }

  } else {
    // handle integers: -5 and 5; but only relative if negative, otherwise absolute
    parsed = value;
    if (parsed < 0) {
      relative_vol = true;
      negative = true;
      parsed = Math.abs(value);
    }
  }

  log.debug(`lgsb.js: set vol; relative: ${relative_vol}, neg: ${negative}, number: ${parsed}`);
  if (relative_vol) {
    this.get_volume((nowvol) => {
      if (negative) {
        newvol = nowvol - parsed;
      } else {
        newvol = nowvol + parsed;
      }
      if (newvol < 0) {
        newvol = 0;
      }

      // set volume
      log.debug(`lgsb.js: volume set relative to ${newvol}`);
      this.set_volume_raw(newvol, callback);
      return;
    });

  } else {
    // absolute volume, just take the parsed number
    newvol = parsed;
  }

  log.debug(`lgsb.js: volume set absolute to ${newvol}`);
  this.set_volume_raw(newvol, callback);
}
/*---------------------------------------------------------------------------*/
let set_volume_raw = function(value, callback) {
  this._set("SPK_LIST_VIEW_INFO" ,{"i_vol": value}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_mute = function(enable, callback) {
  this._set("SPK_LIST_VIEW_INFO" ,{"b_mute": enable}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let factory_reset = function(callback) {
  log.log(`lgsb.js: Factory reset requested`);
  this.sendqueue.push({
    command: {"cmd": "set", "msg": "FACTORY_SET_REQ"},
    callback: callback});

  this._send_to_device();
}
/*---------------------------------------------------------------------------*/
let test_tone = function(callback) {
  log.log(`lgsb.js: Test tone requested`);
  this.sendqueue.push({
    command: {"cmd": "set", "msg": "TEST_TONE_REQ"},
    callback: callback});

  this._send_to_device();
}
/*---------------------------------------------------------------------------*/
let get_speakerinfo = function(callback) {
  this._get("SPK_LIST_VIEW_INFO", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_volume = function(callback) {
  this.get_speakerinfo((result) => {
    callback(result.data.i_vol);
  });
}
/*---------------------------------------------------------------------------*/
let get_mute = function(callback) {
  this.get_speakerinfo((result) => {
    callback(result.data.b_mute);
  });
}
/*---------------------------------------------------------------------------*/
let get_nightmode = function(callback) {
  this.get_settings((result) => {
    callback(result.data.b_night_time);
  });
}
/*---------------------------------------------------------------------------*/
let get_name = function(callback) {
  this.get_settings((result) => {
    callback(result.data.s_user_name);
  });
}
/*---------------------------------------------------------------------------*/
let get_product = function(callback) {
  this.get_product_info((result) => {
    callback(result.data.s_model_name);
  });
}
/*---------------------------------------------------------------------------*/
let get_input = function(callback) {
  this.get_func((result) => {
    let ans = "Unknown";
    let funcnum = result.data.i_curr_func;
    if (funcnum < inputs.length) {
      ans = inputs[funcnum];
    }
    callback(ans);
  });
}
/*---------------------------------------------------------------------------*/
let get_basic_info = function(callback) {
  // no need to do this unless we're interested in the result
  if (typeof callback != "function") {
    return;
  }

  let returnobj = {};

  // gather information
  this.get_settings((result) => {
    returnobj.nightmode = result.data.b_night_time;
    returnobj.name = result.data.s_user_name;
    returnobj.ip = result.data.s_ipv4_addr;

    this.get_speakerinfo((result) => {
      returnobj.volume = result.data.i_vol;
      returnobj.volume_min = result.data.i_vol_min;
      returnobj.volume_max = result.data.i_vol_max;
      returnobj.muted = result.data.b_mute;

      this.get_input((result) => {
        returnobj.input = result;
        callback(returnobj);
      });
    });
  });
}
/*---------------------------------------------------------------------------*/
let get_info = function(callback) {
}
/*---------------------------------------------------------------------------*/
let set_logging = function(level) {
  if (["silent", "error", "warn", "info", "debug", "trace"].indexOf(level) >= 0) {
    log.setLevel(level); // silent, error, warn, info, debug, trace
  }
}
/*---------------------------------------------------------------------------*/
class lg_soundbar {
  constructor(ip) {
    // -------------------------------
    // connection
    this.ipaddr = ip;
    this.tcpport = 9741;
    this.is_connected = false;
    this.sendqueue = [];
    this.current_send = undefined;

    // internal: to save latency, we keep the connection
    // open for a while and automatically disconnect after a while. This timer
    // handles that. Each send from us resets the timer.
    this.auto_disconnect_timeout = 5000;
    this.auto_disconnect_timer = undefined;
    this.reconnect_timer = undefined;

    // -------------------------------
    this.tcpclient = new net.Socket();
    this.tcpclient.on('close', _tcp_closed.bind(this));
    this.tcpclient.on('data', _tcp_data.bind(this));
    this.tcpclient.on('error', _tcp_error.bind(this));
    // we don't open the socket until we send something
    // other events: end (remote end closed), ready, timeout

    // -------------------------------
    // internal helpers
    this._create_packet = _create_packet.bind(this);
    this._encrypt = _encrypt.bind(this);
    this._decrypt = _decrypt.bind(this);
    this._connect_to_device = _connect_to_device.bind(this);
    this._send_to_device = _send_to_device.bind(this);
    this._disconnect = _disconnect.bind(this);
    this._tcp_opened = _tcp_opened.bind(this);

    // not meant for external use since they're kind of raw
    this._get = _get.bind(this);
    this._set_view_info = _set_view_info.bind(this);
    this._set = _set.bind(this);
  }
}
/*---------------------------------------------------------------------------*/
exports.lg_soundbar = lg_soundbar;

// In the below, anything marked as (raw*) returns the raw query answer from the
// speaker, as an object (speaker answers in JSON). This means that the info
// you're after may be a couple of layers deep down. See the extended-docs.txt
// for examples.
// 
// Functions _not_ marked as (raw*) returns either a boolean, string, or integer.
// Eg volume -> 10, or nightmode -> false.

// set logging level
lg_soundbar.prototype.set_logging = set_logging;

// ---------------------------------------------------Gets
// (raw*) get equalizer settings
lg_soundbar.prototype.get_eq = get_eq;

// (raw*) get play information (eg what's playing)
lg_soundbar.prototype.get_play = get_play;

// (raw*) get eg input
lg_soundbar.prototype.get_func = get_func;

// (raw*) get settings, eg night mode and per-channel settings
lg_soundbar.prototype.get_settings = get_settings;

// (raw*) get information on this product, eg product name
lg_soundbar.prototype.get_product_info = get_product_info;

// (raw*) get c4a status (EULA agreement?)
lg_soundbar.prototype.get_c4a_info = get_c4a_info;

// (raw*) get 
lg_soundbar.prototype.get_radio_info = get_radio_info;

// (raw*) (unknown, "not supported" on SP8YA)
lg_soundbar.prototype.get_ap_info = get_ap_info;

// (raw*) get firmware update information
lg_soundbar.prototype.get_update_info = get_update_info;

// (raw*) get system software information
lg_soundbar.prototype.get_build_info = get_build_info;

// (raw*) get product options info (region info?)
lg_soundbar.prototype.get_option_info = get_option_info;

// (raw*) get UUID and wifi/mac MAC address information
lg_soundbar.prototype.get_mac_info = get_mac_info;

// (raw*) (unknown, no answer)
lg_soundbar.prototype.get_mem_mon_info = get_mem_mon_info;

// (raw*) (unknown, no answer)
lg_soundbar.prototype.get_test_info = get_test_info;

// (raw*) get various information, such as volume.
lg_soundbar.prototype.get_speakerinfo = get_speakerinfo;

// get the text-friendly name of the device; can be set by user, string eg "LG_Speaker_SP8YA"
lg_soundbar.prototype.get_name = get_name;

// get the device product name, string eg "SP8YA"
lg_soundbar.prototype.get_product = get_product;

// get the current input name, string eg "Bluetooth"
lg_soundbar.prototype.get_input = get_input;

// get master volume, integer eg 10
lg_soundbar.prototype.get_volume = get_volume;

// get whether this is muted. boolean eg false 
lg_soundbar.prototype.get_mute = get_mute;

// get whether night mode is active. boolean eg false 
lg_soundbar.prototype.get_nightmode = get_nightmode;

// get basic information: input, volume, etc. Returns an object.
lg_soundbar.prototype.get_basic_info = get_basic_info;

// get full information. Returns an object.
lg_soundbar.prototype.get_info = get_info;

// ---------------------------------------------------Sets
// set master volume, integer or string, where can be absolute number, or relative
// in which case the current volume will be fetched first.
// eg set_volume(7)
// eg set_volume("7")
// eg set_volume("+2")
lg_soundbar.prototype.set_volume = set_volume;

// set master volume, integer between min and max (on SP8YA 0..40 inclusive)
lg_soundbar.prototype.set_volume_raw = set_volume_raw;

// set mute status, boolean
lg_soundbar.prototype.set_mute = set_mute;

// set night mode status, boolean
lg_soundbar.prototype.set_night_mode = set_night_mode;

// set input, string that must match inputs, but case insensitive.
// See list of inputs above.
// eg set_input("hdmi")
lg_soundbar.prototype.set_input = set_input;

// set input, integer. See list of inputs to match.
// eg set_input_raw(4)
lg_soundbar.prototype.set_input_raw = set_input_raw;

// set equalizer, string that must match eqs, case insensitive.
// See list of equalizers above.
// eg set_eq("standard")
lg_soundbar.prototype.set_eq = set_eq;

// set equalizer, integer. See list of equalizer to match.
// eg set_eq_raw(4)
lg_soundbar.prototype.set_eq_raw = set_eq_raw;

lg_soundbar.prototype.set_avc = set_avc;
lg_soundbar.prototype.set_drc = set_drc;
lg_soundbar.prototype.set_neuralx = set_neuralx;
lg_soundbar.prototype.set_av_sync = set_av_sync;
lg_soundbar.prototype.set_woofer_level = set_woofer_level;
lg_soundbar.prototype.set_rear_control = set_rear_control;
lg_soundbar.prototype.set_rear_level = set_rear_level;
lg_soundbar.prototype.set_top_level = set_top_level;
lg_soundbar.prototype.set_center_level = set_center_level;
lg_soundbar.prototype.set_tv_remote = set_tv_remote;
lg_soundbar.prototype.set_auto_power = set_auto_power;
lg_soundbar.prototype.set_auto_display = set_auto_display;
lg_soundbar.prototype.set_bt_standby = set_bt_standby;
lg_soundbar.prototype.set_bt_restrict = set_bt_restrict;
lg_soundbar.prototype.set_sleep_time = set_sleep_time;
lg_soundbar.prototype.factory_reset = factory_reset;
lg_soundbar.prototype.test_tone = test_tone;
/*---------------------------------------------------------------------------*/
if (running_as_script) {
  // if called directly from commandline, we run a small example/test
  // ie not "require"d
  let lgsb = new lg_soundbar("192.168.1.135");

  lgsb.get_nightmode((enabled) => {
    console.log(`Night mode enabled? ${enabled}`);
    if (enabled) {
      const new_vol = 11;
      console.log(`Setting volume to ${new_vol}`);
      lgsb.set_volume(new_vol, () => {
      });
    }
  });
}
/*---------------------------------------------------------------------------*/
