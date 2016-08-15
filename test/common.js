/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * test/common.js: common utilities for test suite
 */

var mod_assertplus = require('assert-plus');
var mod_crc = require('crc');
var mod_net = require('net');
var mod_protocol = require('../lib/fast_protocol');
var mod_stream = require('stream');
var mod_util = require('util');
var VError = require('verror');

/* IP used for the server in this test suite */
exports.serverIp = '127.0.0.1';
/* TCP port used by the server in this test suite */
exports.serverPort = 31016;

/* dummy values used as test data */
exports.dummyRpcMethodName = 'testmethod';
exports.dummyValue = { 'movies': [ 'red dawn', 'wargames' ] };
exports.dummyRpcArgs = [ exports.dummyValue ];
exports.dummyResponseData = { 'd': [ exports.dummyValue ] };
exports.dummyResponseEndEmpty = { 'd': [] };
exports.dummyError = new VError({
    'name': 'DummyError',
    'info': {
	'dummyProp': 'dummyVal'
    }
}, 'dummy error message');
exports.dummyResponseError = { 'd': {
    'name': exports.dummyError.name,
    'message': exports.dummyError.message,
    'info': exports.dummyError.info()
} };

exports.makeBigObject = makeBigObject;
exports.writeMessageForEncodedData = writeMessageForEncodedData;
exports.mockServerSetup = mockServerSetup;
exports.mockServerTeardown = mockServerTeardown;
exports.assertRequestError = assertRequestError;
exports.FlowControlSource = FlowControlSource;

/*
 * Construct a plain-old-JavaScript object whose size is linear in "width" and
 * exponential in "depth".
 */
function makeBigObject(width, depth)
{
	var i, rv;

	mod_assertplus.number(width);
	mod_assertplus.number(depth);
	mod_assertplus.ok(depth >= 1);

	rv = {};
	if (depth === 1) {
		for (i = 0; i < width; i++) {
			rv['prop_1_' + i] = 'prop_1_' + i + '_value';
		}
	} else {
		for (i = 0; i < width; i++) {
			rv['prop_' + depth + '_' + i] =
			    makeBigObject(width, depth - 1);
		}
	}

	return (rv);
}

/*
 * Writes into "buf" (a Node buffer) at offset "msgoffset" a Fast packet with
 * message id "msgid", status byte "status", encoded data "dataenc".  This is
 * used to generate *invalid* messages for testing purposes.  If you want to
 * generate valid Fast messages, see the MessageEncoder class.
 */
function writeMessageForEncodedData(buf, msgid, status, dataenc, msgoffset)
{
	var crc, datalen;
	crc = mod_crc.crc16(dataenc);
	datalen = Buffer.byteLength(dataenc);

	buf.writeUInt8(mod_protocol.FP_VERSION_1,
	    msgoffset + mod_protocol.FP_OFF_VERSION);
	buf.writeUInt8(mod_protocol.FP_TYPE_JSON,
	    msgoffset + mod_protocol.FP_OFF_TYPE);
	buf.writeUInt8(status, msgoffset + mod_protocol.FP_OFF_STATUS);
	buf.writeUInt32BE(msgid, msgoffset + mod_protocol.FP_OFF_MSGID);
	buf.writeUInt32BE(crc, msgoffset + mod_protocol.FP_OFF_CRC);
	buf.writeUInt32BE(datalen, msgoffset + mod_protocol.FP_OFF_DATALEN);
	buf.write(dataenc, msgoffset + mod_protocol.FP_OFF_DATA);
}

/*
 * Sets up a server intended for testing.  This is little more than a plain TCP
 * server, since the mock server needs low-level access to the socket.
 *
 * Invokes "callback" when the server is ready.
 */
function mockServerSetup(callback)
{
	var socket;

	socket = mod_net.createServer({ 'allowHalfOpen': true });
	socket.listen(exports.serverPort, exports.serverIp, function () {
		callback(socket);
	});
}

/*
 * Tears down the mock server.
 */
function mockServerTeardown(socket)
{
	socket.close();
}

/*
 * Asserts that the given found_error is a FastRequestError caused by
 * expected_cause.
 */
function assertRequestError(found_error, expected_cause)
{
	mod_assertplus.equal(found_error.name, 'FastRequestError');
	mod_assertplus.equal(found_error.message,
	    'request failed: ' + expected_cause.message);
	mod_assertplus.equal(found_error.cause().name, expected_cause.name);
}


/*
 * A FlowControlSource is an object-mode Readable stream that emits data until
 * the caller calls stop().  This class emits event 'resting' when it has been
 * flow controlled for the specified time.
 *
 *     datum		chunk of data to emit when asked for data
 *
 *     log		bunyan-style logger
 *
 *     restMs		time to wait while flow-controlled before emitting
 *     			'resting'
 */
function FlowControlSource(args)
{
	mod_assertplus.object(args, 'args');
	mod_assertplus.object(args.datum, 'args.datum');
	mod_assertplus.object(args.log, 'args.log');
	mod_assertplus.number(args.restMs, 'args.restMs');

	this.fcs_datum = args.datum;
	this.fcs_log = args.log;
	this.fcs_rest_time = args.restMs;
	this.fcs_reading = false;
	this.fcs_stopped = false;
	this.fcs_flowcontrolled = null;
	this.fcs_timeout = null;
	this.fcs_ntransients = 0;
	this.fcs_nresting = 0;
	this.fcs_nwritten = 0;

	mod_stream.Readable.call(this, {
	    'objectMode': true,
	    'highWaterMark': 16
	});
}

mod_util.inherits(FlowControlSource, mod_stream.Readable);

FlowControlSource.prototype._read = function ()
{
	var i;

	if (this.fcs_reading) {
		this.fcs_log.debug('ignoring _read(): already reading');
		return;
	}

	if (this.fcs_stopped) {
		this.fcs_log.debug('_read() pushing end-of-stream');
		this.push(null);
		return;
	}

	this.fcs_reading = true;
	if (this.fcs_timeout !== null) {
		this.fcs_ntransients++;
		clearTimeout(this.fcs_timeout);
		this.fcs_timeout = null;
	}

	this.fcs_log.trace('reading');
	for (i = 1; ; i++) {
		this.fcs_nwritten++;
		if (!this.push(this.fcs_datum)) {
			break;
		}
	}

	this.fcs_log.trace({
	    'nwritten': this.fcs_nwritten,
	    'ntransients': this.fcs_ntransients,
	    'nresting': this.fcs_nresting
	}, 'flow-controlled after %d objects', i);
	this.fcs_flowcontrolled = new Date();
	this.fcs_timeout = setTimeout(this.onTimeout.bind(this),
	    this.fcs_rest_time);
	this.fcs_reading = false;
};

FlowControlSource.prototype.stop = function ()
{
	this.fcs_stopped = true;
	this._read();
};

FlowControlSource.prototype.onTimeout = function ()
{
	var state = {
	    'nwritten': this.fcs_nwritten,
	    'ntransients': this.fcs_ntransients,
	    'nresting': this.fcs_nresting
	};

	this.fcs_nresting++;
	this.fcs_timeout = null;
	this.fcs_log.debug(state, 'coming to rest');
	this.emit('resting', state);
};
