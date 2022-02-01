/*---------------------------------------------------------------------------*/
// This is a library for interfacing LG Soundbars.
// 
// This library will automatically handle the connection to the speaker,
// automatically maintain/close/reconnect as needed.
/*---------------------------------------------------------------------------*/
// TODO:
// 
// * examples
// * input get/set wrappers
// * handle all tcp events, including errors
// * autodiscovery if IP isn't known (does not answer SSDP it seems)
// * test what happens if soundbar is not on network
// * equalizers
// * handle race condition when two calls are made, yet the first is not yet
//   connected, two system calls for socket is made -> crash
//    -> change flag to eg "connected_or_connecting"
//    
// * harden up the data receive with sanity checks that valid packet was received
//    --sometimes cryptolib complains, perhaps too large incoming so divided into
//      >1 packet -> fragmented incoming
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
log.setLevel("trace"); // silent, error, warn, info, debug, trace
// log.setLevel("silent"); // silent, error, warn, info, debug, trace
/*---------------------------------------------------------------------------*/
// cipher
const ciphertype = 'aes-256-cbc';
const iv = "'%^Ur7gy$~t+f)%@";
const key = "T^&*J%^7tr~4^%^&I(o%^!jIJ__+a0 k";
/*---------------------------------------------------------------------------*/
// const equalizers = ["Standard", "Bass", "Flat", "Boost", "Treble and Bass", "User",
//               "Music", "Cinema", "Night", "News", "Voice", "ia_sound",
//               "Adaptive Sound Control", "Movie", "Bass Blast", "Dolby Atmos",
//               "DTS Virtual X", "Bass Boost Plus", "DTS X"];

// STANDARD = 0
// BASS = 1
// FLAT = 2
// BOOST = 3
// TREBLE_BASS = 4
// USER_EQ = 5
// MUSIC = 6
// CINEMA = 7
// NIGHT = 8
// NEWS = 9
// VOICE = 10
// IA_SOUND = 11
// ASC = 12
// MOVIE = 13
// BASS_BLAST = 14
// DOLBY_ATMOS = 15
// DTS_VIRTUAL_X = 16
// BASS_BOOST_PLUS = 17
// DTS_X = 18

// const inputs = ["Wifi", "Bluetooth", "Portable", "Aux", "Optical", "CP", "HDMI",
//              "ARC", "Spotify", "Optical2", "HDMI2", "HDMI3", "LG TV", "Mic",
//              "Chromecast", "Optical/HDMI ARC", "LG Optical", "FM", "USB", "USB2"];

// WIFI = 0
// BLUETOOTH = 1
// PORTABLE = 2
// AUX = 3
// OPTICAL = 4
// CP = 5
// HDMI = 6
// ARC = 7
// SPOTIFY = 8
// OPTICAL_2 = 9
// HDMI_2 = 10
// HDMI_3 = 11
// LG_TV = 12
// MIC = 13
// C4A = 14
// OPTICAL_HDMIARC = 15
// LG_OPTICAL = 16
// FM = 17
// USB = 18
// USB_2 = 19
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
  let decrypter = crypto.createDecipheriv(ciphertype, key, iv);
  let decrypted = decrypter.update(data, "binary") + decrypter.final("binary");
  decrypted = decrypted.toString('utf8');
  return decrypted;
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
    log.log(`send, but queue at 0 so returning; letting live auto for a few seconds`);
    return;
  }

  // sanity check: are we currently waiting for an connect/answer?
  if (this.current_send) {
    log.log(`send, but already current, ie waiting for answer`);
    return;
  }

  log.log(`Sending... Queue at ${this.sendqueue.length}`);
  if (!this.is_connected) {
    log.warn(`Send, but not connected yet.`);
    this._connect_to_device();

  } else {
    if (!this.current_send) {
      // pick next send from the queue, when we recieve an answer, we will
      // invoke the corresponding callback and clear this.current_send
      this.current_send = this.sendqueue.shift();
    }

    // send over network
    log.log(this.current_send.command);
    let payload = this._create_packet(this.current_send.command);
    this.tcpclient.write(payload);

    // restart timer
    this.auto_disconnect_timer = 
      setTimeout(this._disconnect.bind(this), this.auto_disconnect_timeout);

  }
}
/*---------------------------------------------------------------------------*/




/*---------------------------------------------------------------------------*/
// Terminate the TCP connection, mostly from a timer if the connection is idle
let _disconnect = function() {
  log.log(`Closing connection`);

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
    log.log(`Connect, but already connected`);
    return;
  }

  log.log(`Connecting... Queue at ${this.sendqueue.length}`);
  this.tcpclient.connect(this.tcpport, this.ipaddr, _tcp_opened.bind(this));
}
/*---------------------------------------------------------------------------*/
let _tcp_opened = function() {
  log.log(`TCP Connected... Queue at ${this.sendqueue.length}`);
  this.is_connected = true;
  this.auto_disconnect_timer = 
      setTimeout(this._disconnect.bind(this), this.auto_disconnect_timeout);

  // start/keep sending
  this._send_to_device();
}
/*---------------------------------------------------------------------------*/
// Data received from the Soundbar
// Note: needs hardening
let _tcp_data = function(data) {
  if (data[0] != 0x10) {
    log.warn(`warning: header magic not ok`);
  }

  let rxed = _decrypt(data.slice(5));
  let ans = JSON.parse(rxed);

  if (this.current_send) {
    log.log(`current send exists`);
    this.current_send.callback(ans);

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
  log.log('TCP Connection closed');
  this.is_connected = false;

  // stop timer if running; if anything restarts the connection, the timer will
  // be set up again there
  if (this.auto_disconnect_timer) {
    clearTimeout(this.auto_disconnect_timer);
    this.auto_disconnect_timer = undefined;
  }

  // if we should reconnect, set that up
  if (this.sendqueue.length > 0) {
    log.warn(`TCP closed but queue > 0, setting reconnect timer`);
    this.reconnect_timer = setTimeout(this._connect_to_device, 1000);
  }
}
/*---------------------------------------------------------------------------*/












/*---------------------------------------------------------------------------*/
let _getter = function(getwhat, callback, logname) {
  log.log(`${logname}`);
  this.sendqueue.push({
    command: {"cmd": "get", "msg": getwhat},
    callback: callback});

  this._send_to_device();
}
/*---------------------------------------------------------------------------*/
let get_eq = function(callback) {
  this._getter("EQ_VIEW_INFO", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_info = function(callback) {
  this._getter("SETTING_VIEW_INFO", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_play = function(callback) {
  this._getter("PLAY_INFO", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_func = function(callback) {
  this._getter("FUNC_VIEW_INFO", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_settings = function(callback) {
  this._getter("SETTING_VIEW_INFO", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_product_info = function(callback) {
  this._getter("PRODUCT_INFO", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_c4a_info = function(callback) {
  this._getter("C4A_SETTING_INFO", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_radio_info = function(callback) {
  this._getter("RADIO_VIEW_INFO", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_ap_info = function(callback) {
  this._getter("SHARE_AP_INFO", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_update_info = function(callback) {
  this._getter("UPDATE_VIEW_INFO", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_build_info = function(callback) {
  this._getter("BUILD_INFO_DEV", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_option_info = function(callback) {
  this._getter("OPTION_INFO_DEV", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_mac_info = function(callback) {
  this._getter("MAC_INFO_DEV", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_mem_mon_info = function(callback) {
  this._getter("MEM_MON_DEV", callback, functionname());
}
/*---------------------------------------------------------------------------*/
let get_test_info = function(callback) {
  this._getter("TEST_DEV", callback, functionname());
}
/*---------------------------------------------------------------------------*/





/*---------------------------------------------------------------------------*/
let _setter_view_info = function(setwhat, callback, logname) {
  log.log(`${logname}`);
  this.sendqueue.push({
    command: {"cmd": "set", "data": setwhat, "msg": "SETTING_VIEW_INFO"},
    callback: callback});

  this._send_to_device();
}
/*---------------------------------------------------------------------------*/
let _setter = function(category, setwhat, callback, logname) {
  log.log(`${logname}`);
  this.sendqueue.push({
    command: {"cmd": "set", "data": setwhat, "msg": category},
    callback: callback});

  this._send_to_device();
}
/*---------------------------------------------------------------------------*/
let set_night_mode = function(enable, callback) {
  this._setter_view_info({"b_night_time": enable}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_avc = function(enable, callback) {
  this._setter_view_info({"b_auto_vol": enable}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_drc = function(enable, callback) {
  this._setter_view_info({"b_drc": enable}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_neuralx = function(enable, callback) {
  this._setter_view_info({"b_neuralx": enable}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_av_sync = function(value, callback) {
  this._setter_view_info({"i_av_sync": value}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_woofer_level = function(value, callback) {
  this._setter_view_info({"i_woofer_level": value}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_rear_control = function(enable, callback) {
  this._setter_view_info({"b_rear": enable}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_rear_level = function(value, callback) {
  this._setter_view_info({"i_rear_level": value}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_top_level = function(value, callback) {
  this._setter_view_info({"i_top_level": value}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_center_level = function(value, callback) {
  this._setter_view_info({"i_center_level": value}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_tv_remote = function(enable, callback) {
  this._setter_view_info({"b_tv_remote": enable}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_auto_power = function(enable, callback) {
  this._setter_view_info({"b_auto_power": enable}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_auto_display = function(enable, callback) {
  this._setter_view_info({"b_auto_display": enable}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_bt_standby = function(enable, callback) {
  this._setter_view_info({"b_bt_standby": enable}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_bt_restrict = function(enable, callback) {
  this._setter_view_info({"b_conn_bt_limit": enable}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_sleep_time = function(value, callback) {
  this._setter_view_info({"i_sleep_time": value}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_name = function(name, callback) {
  this._setter_view_info({"s_user_name": name}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_eq = function(eq, callback) {
  this._setter("EQ_VIEW_INFO" ,{"i_curr_eq": eq}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_input = function(value, callback) {
  this._setter("FUNC_VIEW_INFO" ,{"i_curr_func": value}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_volume = function(value, callback) {
  this._setter("SPK_LIST_VIEW_INFO" ,{"i_vol": value}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let set_mute = function(enable, callback) {
  this._setter("SPK_LIST_VIEW_INFO" ,{"b_mute": enable}, callback, functionname());
}
/*---------------------------------------------------------------------------*/
let factory_reset = function(callback) {
  log.log(`Factory reset requested`);
  this.sendqueue.push({
    command: {"cmd": "set", "msg": "FACTORY_SET_REQ"},
    callback: callback});

  this._send_to_device();
}
/*---------------------------------------------------------------------------*/
let test_tone = function(callback) {
  log.log(`Test tone requested`);
  this.sendqueue.push({
    command: {"cmd": "set", "msg": "TEST_TONE_REQ"},
    callback: callback});

  this._send_to_device();
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
    // we don't open the socket until we send something

    // -------------------------------
    // internal helpers
    this._create_packet = _create_packet.bind(this);
    this._encrypt = _encrypt.bind(this);
    this._decrypt = _decrypt.bind(this);
    this._connect_to_device = _connect_to_device.bind(this);
    this._send_to_device = _send_to_device.bind(this);
    this._disconnect = _disconnect.bind(this);
    this._tcp_opened = _tcp_opened.bind(this);
    this._getter = _getter.bind(this);
    this._setter_view_info = _setter_view_info.bind(this);
    this._setter = _setter.bind(this);
  }
}
/*---------------------------------------------------------------------------*/
exports.lg_soundbar = lg_soundbar;

// external functions
// Get
lg_soundbar.prototype.get_eq = get_eq;
lg_soundbar.prototype.get_info = get_info;
lg_soundbar.prototype.get_play = get_play;
lg_soundbar.prototype.get_func = get_func;
lg_soundbar.prototype.get_settings = get_settings;
lg_soundbar.prototype.get_product_info = get_product_info;
lg_soundbar.prototype.get_c4a_info = get_c4a_info;
lg_soundbar.prototype.get_radio_info = get_radio_info;
lg_soundbar.prototype.get_ap_info = get_ap_info;
lg_soundbar.prototype.get_update_info = get_update_info;
lg_soundbar.prototype.get_build_info = get_build_info;
lg_soundbar.prototype.get_option_info = get_option_info;
lg_soundbar.prototype.get_mac_info = get_mac_info;
lg_soundbar.prototype.get_mem_mon_info = get_mem_mon_info;
lg_soundbar.prototype.get_test_info = get_test_info;

// Set
lg_soundbar.prototype.set_volume = set_volume;
lg_soundbar.prototype.set_mute = set_mute;
lg_soundbar.prototype.set_night_mode = set_night_mode;

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
lg_soundbar.prototype.set_eq = set_eq;
lg_soundbar.prototype.set_input = set_input;
lg_soundbar.prototype.factory_reset = factory_reset;
lg_soundbar.prototype.test_tone = test_tone;
/*---------------------------------------------------------------------------*/
let get_speakerinfo = function(callback) {
  this._getter("SPK_LIST_VIEW_INFO", callback, functionname());
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
  this.get_info((result) => {
    callback(result.data.b_night_time);
  });
}
/*---------------------------------------------------------------------------*/
// wrappers and new
lg_soundbar.prototype.get_speakerinfo = get_speakerinfo;
lg_soundbar.prototype.get_volume = get_volume;
lg_soundbar.prototype.get_mute = get_mute;
lg_soundbar.prototype.get_nightmode = get_nightmode;
/*---------------------------------------------------------------------------*/
