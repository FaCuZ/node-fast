/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * test/tst.client_request.js: client API per-request test suite
 *
 * This file contains a test runner (runTestCase) that executes test cases
 * following a very prescribed form, where a client connects to the server, the
 * server handles the request (often in surprising ways), and the client reports
 * some number of errors.  This allows us to exercise a lot of different cases,
 * including normal, valid RPC calls, RPC calls that return lots of data, and
 * various edge cases like invalid messages and unexpected end-of-stream events.
 * There are some test cases that require more control over client-server
 * interaction.  These are defined in tst.client_atlarge.js.
 */

var mod_assertplus = require('assert-plus');
var mod_bunyan = require('bunyan');
var mod_net = require('net');
var mod_path = require('path');
var mod_vasync = require('vasync');
var VError = require('verror');

var mod_client = require('../lib/fast_client');
var mod_protocol = require('../lib/fast_protocol');
var mod_testcommon = require('./common');

var testLog;
var serverSocket;
var serverPort = 31016;
var serverIp = '127.0.0.1';

function main()
{
	var done = false;

	testLog = new mod_bunyan({
	    'name': mod_path.basename(__filename),
	    'level': process.env['LOG_LEVEL'] || 'fatal'
	});

	serverSocket = mod_net.createServer({ 'allowHalfOpen': true });
	serverSocket.listen(serverPort, serverIp, function () {
		testLog.info('server listening');
		mod_vasync.forEachPipeline({
		    'inputs': mockResponders,
		    'func': runTestCase
		}, function (err) {
			if (err) {
				throw (err);
			}

			done = true;
			serverSocket.close();
			console.log('%s tests passed',
			    mod_path.basename(__filename));
		});
	});

	process.on('exit', function (code) {
		if (code === 0) {
			mod_assertplus.ok(done, 'premature exit');
		}
	});
}

function runTestCase(testcase, callback)
{
	var client, csock, request;
	var data, errors, isdone, done;
	var log;

	log = testLog.child({ 'testcase': testcase['name'] });
	isdone = false;
	data = [];
	errors = {
	    'socket': null,
	    'client': null,
	    'request': null
	};

	console.log('test case: %s', testcase.name);

	/*
	 * Before initiating the client connection, set up a handler on the
	 * server socket to handle this connection by invoking this test case's
	 * serverReply function.
	 */
	serverSocket.once('connection', function (sock) {
		var encoder, decoder;

		testLog.debug('server received connection');

		mod_assertplus.ok(!isdone);
		encoder = new mod_protocol.MessageEncoder();
		encoder.pipe(sock);

		decoder = new mod_protocol.MessageDecoder();
		sock.pipe(decoder);
		decoder.on('data', function (message) {
			testcase['serverReply'](sock, message, encoder,
			    decoder);
		});
	});

	/*
	 * Set up the client socket, FastClient object, and make an RPC request.
	 * We'll invoke the done() closure (defined below) when the RPC
	 * completes with either an "error" or "end" event.
	 */
	csock = mod_net.createConnection({
	    'port': serverPort,
	    'host': serverIp,
	    'allowHalfOpen': true
	});

	csock.on('error', function (err) {
		log.debug(err, 'client socket error');
		mod_assertplus.ok(!isdone);
		errors.socket = err;
	});

	client = new mod_client.FastClient({
	    'log': log.child({ 'component': 'FastClient' }),
	    'nRecentRequests': 10,
	    'transport': csock
	});

	client.on('error', function (err) {
		log.debug(err, 'client error');
		mod_assertplus.ok(!isdone);
		errors.client = err;
	});

	request = client.rpc({
	    'rpcmethod': 'testmethod',
	    'rpcargs': dummyRequestArgs
	});

	request.on('error', function (err) {
		log.debug(err, 'client request error');
		mod_assertplus.ok(!isdone);
		errors.request = err;

		/*
		 * Schedule done() for the next tick to allow any socket or
		 * client errors to be emitted.  This isn't necessarily enough
		 * to ensure that we've waited long enough, but it should work
		 * in practice.
		 */
		setImmediate(done);
	});

	request.on('data', function (d) {
		log.debug(d, 'client request data');
		mod_assertplus.ok(!isdone);
		data.push(d);
	});

	request.on('end', function () {
		log.debug('client request ended');
		mod_assertplus.ok(!isdone);
		done();
	});

	done = function () {
		mod_assertplus.ok(!isdone);
		isdone = true;
		testcase['clientCheck'](data, errors);
		csock.end();
		callback();
	};
}

/*
 * These dummy values are used in responses for various test cases.
 */
var dummyValue = { 'movies': [ 'red dawn', 'wargames' ] };
var dummyResponseEndEmpty = { 'd': [] };
var dummyResponseData = { 'd': [ dummyValue ] };
var dummyRequestArgs = [ dummyValue ];
var dummyError = new VError({
    'name': 'DummyError',
    'info': {
	'dummyProp': 'dummyVal'
    }
}, 'dummy error message');
dummyError.context = { 'dummyProp': 'dummyVal' };
var dummyResponseError = { 'd': {
    'name': dummyError.name,
    'message': dummyError.message,
    'info': dummyError.info()
} };

/*
 * "mockResponders" describes a bunch of client test cases by describing what
 * the server should do and what users of the client API should see when that
 * happens.
 *
 *     name          a human-readable label for this test case
 *
 *     serverReply   a function invoked when the client makes this request.
 *                   This function implements the server's response.  The
 *                   function is invoked as:
 *
 *                       serverReply(socket, message, encoder)
 *
 *                   where
 *
 *               socket     the net.Socket connected to the client, which is
 *                          useful for injecting malformed responses or
 *                          generating socket errors
 *
 *               message    the first well-formed message read from the socket,
 *                          which is useful for common test cases of responding
 *                          to a basic RPC request
 *
 *               encoder    a FastMessageEncoder connected to the socket, which
 *                          is convenient for sending well-formed responses.
 *
 *               decoder    a FastMessageDecoder connected to the socket, which
 *                          is convenient for receiving well-formed messages
 *
 *     clientCheck   a function invoked after the test case has completed in
 *                   to verify client behavior.  It's invoked as:
 *
 *                       clientCheck(data, error)
 *
 *                   where
 *
 *               data    an array of "data" events emitted by the client
 *
 *               errors  an object with properties for each possible error
 *                       emitted during the test, including "socket", "client",
 *                       and "request".
 */

var mockResponders = [ {
    'name': 'ok, no data',
    'serverReply': function (socket, message, encoder) {
	assertNormalRequest(message);
	encoder.end({
	    'msgid': message.msgid,
	    'status': mod_protocol.FP_STATUS_END,
	    'data': dummyResponseEndEmpty
	});
    },
    'clientCheck': function (data, errors) {
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client === null);
	mod_assertplus.ok(errors.request === null);
	mod_assertplus.equal(data.length, 0);
    }

}, {
    'name': 'ok, with 4 data messages, with 0-4 data objects per message',
    'serverReply': function (socket, message, encoder) {
	var nmessages, i, j, d;

	assertNormalRequest(message);
	nmessages = 5;
	for (i = 0; i < nmessages; i++) {
		d = [];
		for (j = 0; j < i; j++) {
			d.push('string ' + i + '_' + j);
		}
		encoder.write({
		    'msgid': message.msgid,
		    'status': i == nmessages - 1 ?
		        mod_protocol.FP_STATUS_END :
			mod_protocol.FP_STATUS_DATA,
		    'data': { 'd': d }
		});
	}

	encoder.end();
    },
    'clientCheck': function (data, errors) {
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client === null);
	mod_assertplus.ok(errors.request === null);
	mod_assertplus.deepEqual(data, [
	    'string 1_0', 'string 2_0', 'string 2_1', 'string 3_0',
	    'string 3_1', 'string 3_2', 'string 4_0', 'string 4_1',
	    'string 4_2', 'string 4_3'
	]);
    }

}, {
    'name': 'error, no data',
    'serverReply': function (socket, message, encoder) {
	assertNormalRequest(message);
	encoder.end({
	    'msgid': message.msgid,
	    'status': mod_protocol.FP_STATUS_ERROR,
	    'data': dummyResponseError
	});
    },
    'clientCheck': function (data, errors) {
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client === null);
	mod_assertplus.ok(errors.request !== null);
	mod_assertplus.equal(data.length, 0);
	assertServerError(errors.request, dummyError);
    }

}, {
    'name': 'error, after data',
    'serverReply': function (socket, message, encoder) {
	var nmessages, i;
	assertNormalRequest(message);

	nmessages = 5;
	for (i = 0; i < nmessages; i++) {
		encoder.write({
		    'msgid': message.msgid,
		    'status': mod_protocol.FP_STATUS_DATA,
		    'data': dummyResponseData
		});
	}

	encoder.end({
	    'msgid': message.msgid,
	    'status': mod_protocol.FP_STATUS_ERROR,
	    'data': dummyResponseError
	});
    },
    'clientCheck': function (data, errors) {
	var i;
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client === null);
	mod_assertplus.ok(errors.request !== null);
	mod_assertplus.equal(data.length, 5);

	for (i = 0; i < data.length; i++) {
		mod_assertplus.deepEqual(data[i], dummyValue);
	}

	assertServerError(errors.request, dummyError);
    }

}, {
    'name': 'unexpected end of stream: no response at all',
    'serverReply': function (socket, message, encoder) {
	socket.end();
    },
    'clientCheck': function (data, errors) {
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client !== null);
	mod_assertplus.ok(errors.request !== null);
	mod_assertplus.equal(data.length, 0);

	mod_assertplus.equal(errors.client.name, 'FastProtocolError');
	mod_assertplus.equal(errors.client.message,
	    'unexpected end of transport stream');
	assertRequestError(errors.request, errors.client);
    }

}, {
    'name': 'unexpected end of stream: partial message response',
    'serverReply': function (socket, message, encoder) {
	var buf = new Buffer(1);
	buf.writeUInt8(mod_protocol.FP_VERSION_1, mod_protocol.FP_OFF_VERSION);
	socket.end(buf);
    },
    'clientCheck': function (data, errors) {
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client !== null);
	mod_assertplus.ok(errors.request !== null);
	mod_assertplus.equal(data.length, 0);

	mod_assertplus.equal(errors.client.name, 'FastProtocolError');
	mod_assertplus.equal(errors.client.message,
	    'fast protocol: incomplete message at end-of-stream');
	assertRequestError(errors.request, errors.client);
    }

}, {
    'name': 'unexpected end of stream: complete DATA message, no END',
    'serverReply': function (socket, message, encoder) {
	encoder.end({
	    'msgid': message.msgid,
	    'status': mod_protocol.FP_STATUS_DATA,
	    'data': dummyResponseData
	});
    },
    'clientCheck': function (data, errors) {
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client !== null);
	mod_assertplus.ok(errors.request !== null);
	mod_assertplus.equal(data.length, 1);
	mod_assertplus.deepEqual(data[0], dummyValue);

	mod_assertplus.equal(errors.client.name, 'FastProtocolError');
	mod_assertplus.equal(errors.client.message,
	    'unexpected end of transport stream');
	assertRequestError(errors.request, errors.client);
    }

}, {
    'name': 'server responds with wrong msgid',
    'serverReply': function (socket, message, encoder) {
	mod_assertplus.ok(message.msgid != 47);
	encoder.end({
	    'msgid': 47,
	    'status': mod_protocol.FP_STATUS_END,
	    'data': dummyResponseData
	});
    },
    'clientCheck': function (data, errors) {
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client !== null);
	mod_assertplus.ok(errors.request !== null);
	mod_assertplus.equal(data.length, 0);

	mod_assertplus.equal(errors.client.name, 'FastProtocolError');
	mod_assertplus.equal(errors.client.message,
	    'fast protocol: received message with unknown msgid 47');
	assertRequestError(errors.request, errors.client);
    }

}, {
    'name': 'server responds with invalid message',
    'serverReply': function (socket, message, encoder) {
	/*
	 * This test case exercises client handling of all decoder errors.  The
	 * various decoder failure modes are tested separately in
	 * ./test/protocol/tst.decoder.js.
	 */
	var buf = new Buffer(mod_protocol.FP_HEADER_SZ + 1);
	mod_testcommon.writeMessageForEncodedData(
	    buf, 3, mod_protocol.FP_STATUS_END, '{', 0);
	socket.end(buf);
    },
    'clientCheck': function (data, errors) {
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client !== null);
	mod_assertplus.ok(errors.request !== null);
	mod_assertplus.equal(data.length, 0);

	mod_assertplus.equal(errors.client.name, 'FastProtocolError');
	mod_assertplus.ok(/fast protocol: invalid JSON/.test(
	    errors.client.message));
	assertRequestError(errors.request, errors.client);
    }

}, {
    'name': 'server responds with invalid error',
    'serverReply': function (socket, message, encoder) {
	encoder.end({
	    'msgid': message.msgid,
	    'status': mod_protocol.FP_STATUS_ERROR,
	    'data': { 'd': {} }
	});
    },
    'clientCheck': function (data, errors) {
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client !== null);
	mod_assertplus.ok(errors.request !== null);
	mod_assertplus.equal(data.length, 0);

	mod_assertplus.equal(errors.client.name, 'FastProtocolError');
	mod_assertplus.ok(/data.d for ERROR messages must have name/.test(
	    errors.client.message));
	assertRequestError(errors.request, errors.client);
    }

}, {
    'name': 'ok, with 10,000 data messages',
    'serverReply': function (socket, message, encoder) {
	var nmessages, i;

	assertNormalRequest(message);
	nmessages = 10000;
	for (i = 0; i < nmessages; i++) {
		encoder.write({
		    'msgid': message.msgid,
		    'status': mod_protocol.FP_STATUS_DATA,
		    'data': { 'd': [ 'string_' + i ] }
		});
	}

	encoder.end({
	    'msgid': message.msgid,
	    'status': mod_protocol.FP_STATUS_END,
	    'data': { 'd': [ 'lastmessage' ] }
	});
    },
    'clientCheck': function (data, errors) {
	var i;
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client === null);
	mod_assertplus.ok(errors.request === null);
	mod_assertplus.equal(data.length, 10001);

	for (i = 0; i < data.length - 1; i++) {
		mod_assertplus.equal(data[i], 'string_' + i);
	}

	mod_assertplus.equal(data[data.length - 1], 'lastmessage');
    }

}, {
    'name': 'ok, with 10,000 items in an END message',
    'serverReply': function (socket, message, encoder) {
	var nitems, d, i;

	assertNormalRequest(message);
	nitems = 10000;
	d = [];
	for (i = 0; i < nitems; i++) {
		d.push('string_' + i);
	}

	encoder.end({
	    'msgid': message.msgid,
	    'status': mod_protocol.FP_STATUS_END,
	    'data': { 'd': d }
	});
    },
    'clientCheck': function (data, errors) {
	var i;
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client === null);
	mod_assertplus.ok(errors.request === null);
	mod_assertplus.equal(data.length, 10000);

	for (i = 0; i < data.length; i++) {
		mod_assertplus.equal(data[i], 'string_' + i);
	}
    }
} ];

/*
 * Asserts that the given Fast message represents a well-formed RPC request.
 */
function assertNormalRequest(message)
{
	mod_assertplus.equal(message.status, mod_protocol.FP_STATUS_DATA);
	mod_assertplus.object(message.data);
	mod_assertplus.object(message.data.m);
	mod_assertplus.string(message.data.m.name);
	mod_assertplus.array(message.data.d);
}

/*
 * Asserts that the given found_error matches what we would expect if the server
 * responded with the given server_error.
 */
function assertServerError(found_error, server_error)
{
	/*
	 * Our current behavior is extremely pedantic, but at least it's clear
	 * what really happened in all cases.
	 */
	var cause, info;

	mod_assertplus.equal(found_error.name, 'FastRequestError');
	mod_assertplus.equal(found_error.message,
	    'request failed: server error: ' + server_error.message);

	cause = found_error.cause();
	mod_assertplus.equal(cause.name, 'FastServerError');
	mod_assertplus.equal(cause.message,
	    'server error: ' + server_error.message);

	cause = cause.cause();
	mod_assertplus.equal(cause.name, server_error.name);
	mod_assertplus.equal(cause.message, server_error.message);

	info = found_error.info();
	mod_assertplus.number(info['rpcMsgid'], 1);
	mod_assertplus.equal(info['rpcMethod'], 'testmethod');
	mod_assertplus.equal(info['dummyProp'], 'dummyVal');
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

main();
