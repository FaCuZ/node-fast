/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * lib/fast_client.js: public node-fast client interface
 */

var mod_assertplus = require('assert-plus');
var mod_events = require('events');
var mod_util = require('util');
var VError = require('verror');

var mod_protocol = require('./fast_protocol');
var mod_client_request = require('./fast_client_request');

exports.FastClient = FastClient;


/*
 * A FastClient is an object used to make RPC requests to a remote Fast server.
 * This client does not manage the connection to the remote server.  That's the
 * responsibility of the caller.
 *
 * Named arguments:
 *
 *     log		bunyan-style logger
 *
 *     nRecentRequests	count of recent requests to keep track of (for
 *     			debugging)
 *
 *     transport	usually a socket connected to the remote server, but
 *     			this could be any data-mode duplex stream.  This client
 *     			will write messages to the transport and parse responses
 *     			from the transport.  This client listens for 'error'
 *     			events and end-of-stream only so that it can report
 *     			request failures.  The caller is also expected to listen
 *     			for these errors and handle reconnection appropriately.
 *
 * On 'error', the caller should assume that the current connection to the
 * server is in an undefined state and should not be used any more.  Any
 * in-flight RPC will be terminated gracefully (i.e., with an "error" or "end"
 * event).
 */
function FastClient(args)
{
	mod_assertplus.object(args, 'args');
	mod_assertplus.object(args.log, 'args.log');
	mod_assertplus.number(args.nRecentRequests, 'args.nRecentRequests');
	mod_assertplus.object(args.transport, 'args.transport');

	this.fc_log = args.log;
	this.fc_transport = args.transport;
	this.fc_nrecent = args.nRecentRequests;

	/* RPC and protocol state */
	this.fc_msgid = 0; 		/* last msgid used */
	this.fc_pending = {}; 		/* pending requests */
	this.fc_aborted = {};		/* aborted, not-yet-finished requests */
	this.fc_nrpc_started = 0;	/* requests issued */
	this.fc_nrpc_done = 0;		/* requests completed */
	this.fc_recentrpc = [];		/* recently completed requests */
	this.fc_error = null;		/* first fatal error, if any */
	this.fc_nerrors = 0;		/* count of fatal errors */

	/* transport and message helper objects */
	this.fc_transport_onerr = null;	/* error listener */
	this.fc_transport_onend = null;	/* end listener */
	this.fc_msgencoder = new mod_protocol.MessageEncoder();
	this.fc_msgdecoder = new mod_protocol.MessageDecoder();

	/* transport state */
	this.fc_detached = false;	 /* caller detached us */
	this.fc_transport_ended = false; /* transport detached us */

	mod_events.EventEmitter.call(this);
	this.attach();
}

mod_util.inherits(FastClient, mod_events.EventEmitter);

/*
 * [public] Initiate an RPC request.  Named parameters include:
 *
 *     rpcmethod	(string)	name of the RPC method to invoke
 *
 *     rpcargs		(object)	values of arguments passed to the RPC
 *
 * The semantics of "rpcmethod" and "rpcargs" are defined by the server.
 *
 * The return value is an object-mode readable stream that emits zero or more
 * messages from the server.  As with other readable streams, "end" denotes
 * successful completion, and "error" denotes unsuccessful completion.  This
 * stream does not support flow control, so the server must be trusted, and the
 * caller must avoid making requests that return large amounts of data faster
 * than the caller can process it.  Additionally, the stream is already reading
 * when the caller gets it, so there's no need to call read(0) to kick off the
 * RPC.
 */
FastClient.prototype.rpc = function (args)
{
	var msgid, request, message;

	mod_assertplus.object(args, 'args');
	mod_assertplus.string(args.rpcmethod, 'method.rpcmethod');
	mod_assertplus.array(args.rpcargs, 'args.rpcargs');

	msgid = this.allocMessageId();
	request = new mod_client_request.FastRpcRequest({
	    'client': this,
	    'msgid': msgid,
	    'rpcmethod': args.rpcmethod,
	    'rpcargs': args.rpcargs
	});

	mod_assertplus.ok(!this.fc_pending.hasOwnProperty(msgid));
	this.fc_pending[msgid] = request;
	this.fc_nrpc_started++;

	if (this.fc_detached || this.fc_transport_ended) {
		this.fc_log.trace('skipping new request (transport detached)');
		request.frq_skip = true;
		this.requestFail(request, new VError({
		    'name': 'TransportError'
		}, 'transport detached'));
		return (request);
	}

	message = {
	    'msgid': msgid,
	    'status': mod_protocol.FP_STATUS_DATA,
	    'data': {
		'm': {
		    /* XXX "utc" field? */
		    'name': args.rpcmethod
		},
		'd': args.rpcargs
	    }
	};

	this.fc_log.trace(message, 'outgoing message');
	this.fc_msgencoder.write(message);
	return (request);
};

/*
 * Disconnect entirely from the underlying transport.  Do not read from it or
 * write to it and remove any event handlers.
 */
FastClient.prototype.detach = function ()
{
	if (this.fc_detached) {
		return;
	}

	this.fc_detached = true;
	this.fc_transport.removeListener('end', this.fc_transport_onend);
	this.fc_transport.removeListener('error', this.fc_transport_onerror);
	this.fc_transport.unpipe(this.fc_msgdecoder);
	this.fc_msgencoder.unpipe(this.fc_transport);

	this.requestAbortAll(new VError('client detached from transport'));
};

/*
 * private methods
 */

FastClient.prototype.attach = function ()
{
	var self = this;

	this.fc_transport.pipe(this.fc_msgdecoder, { 'end': false });
	this.fc_msgencoder.pipe(this.fc_transport, { 'end': false });

	/*
	 * It's non-idiomatic to use the "data" event because it defeats flow
	 * control.  However, this abstraction cannot support flow control
	 * anyway, but clients can already deal with this by limiting the size
	 * of responses.  Since we know our message decoder is an object-mode
	 * stream, we may as well just read objects with this handler.
	 */
	this.fc_msgdecoder.on('data',
	    function onDecoderMessage(message) { self.onMessage(message); });
	this.fc_msgdecoder.on('error',
	    function onDecoderError(err) { self.fatalError(err); });

	/*
	 * By the nature of this abstraction, we don't own the transport.  But
	 * we still want to know when it either emits "end" or "error" so that
	 * we can know that any outstanding requests will not be completed.
	 * Some modules use "close" for this, but transports are not required to
	 * emit that event.  They should emit one of these two.
	 */
	this.fc_transport_onend = function onTransportEnd() {
		var err;

		self.fc_transport_ended = true;

		/*
		 * There's no problem with seeing end-of-stream as long as we
		 * have no requests pending and are not asked to make any more
		 * requests.  Remember, the caller is separately responsible for
		 * detecting this case for the purpose of reconnection, if
		 * desired.
		 */
		if (self.fc_nrpc_started > self.fc_nrpc_done) {
			err = new VError({
			    'name': 'FastProtocolError'
			}, 'unexpected end of transport stream');
			self.fatalError(err);
		}
	};

	this.fc_transport_onerr = function onTransportError(err) {
		self.fatalError(new VError({
		    'name': 'TransportError',
		    'cause': err
		}, 'unexpected error on transport'));
	};

	this.fc_transport.on('end', this.fc_transport_onend);
	this.fc_transport.on('error', this.fc_transport_onerr);
};

/*
 * Return the next message id.
 */
FastClient.prototype.allocMessageId = function ()
{
	if (++this.fc_msgid >= mod_protocol.FP_MSGID_MAX) {
		this.fc_msgid = 1;
	}

	return (this.fc_msgid);
};

/*
 * Record an error that's fatal to this client.  We emit the first one and abort
 * all outstanding requests.  If we see more than one, we simply log and count
 * subsequent ones.
 */
FastClient.prototype.fatalError = function (err)
{
	this.fc_log.error(err);
	this.fc_nerrors++;

	if (this.fc_error !== null) {
		return;
	}

	this.fc_error = err;
	this.emit('error', err);
	this.requestAbortAll(err);
};

/*
 * Abort all pending requests, as with requestAbort(error).
 */
FastClient.prototype.requestAbortAll = function (error)
{
	var msgid;

	for (msgid in this.fc_pending) {
		mod_assertplus.ok(
		    this.requestIsPending(this.fc_pending[msgid]));
		this.requestAbort(this.fc_pending[msgid], error);
		mod_assertplus.ok(!this.fc_pending.hasOwnProperty(msgid));
	}
};

/*
 * Abort the given request with an error indicating the request was aborted.  If
 * "error" is provided, then the given error will be provided as the cause of
 * the abort error.  If the request has already completed in any way (including
 * having been previously aborted), this will do nothing.
 */
FastClient.prototype.requestAbort = function (request, error)
{
	var msgid;

	if (!this.requestIsPending(request)) {
		return;
	}

	mod_assertplus.optionalObject(error, 'error');

	msgid = request.frq_msgid;
	mod_assertplus.ok(this.fc_pending[msgid] == request);
	request.frq_aborted = true;

	/*
	 * The history of cancellation in node-fast is somewhat complicated.
	 * Early versions did not support cancellation of in-flight requests.
	 * Cancellation was added, but old servers would interpret the
	 * cancellation message as a new request for the same RPC, which is
	 * extremely dangerous.  (Usually, the arguments would be invalid, but
	 * that's only the best-case outcome.)  We could try to avoid this by
	 * avoiding specifying the RPC method name in the cancellation request.
	 * Since the protocol was never well-documented, the correctness of this
	 * approach is mainly determined by what other servers do with it.
	 * Unfortunately, old servers are likely to handle it as an RPC method
	 * of some kind, which triggers an unrelated bug: if old servers
	 * received a request for a method that's not registered, they just
	 * hang on it, resulting in a resource leak.
	 *
	 * Things are a little better on more modern versions of the fast
	 * server, where if you send a cancellation request and the RPC is not
	 * yet complete when the server processes it, then the server may stop
	 * processing the RPC and send back an acknowledgment of sorts.
	 * However, that doesn't mean the request did not complete, since the
	 * implementation may not have responded to the cancellation.  And more
	 * seriously, if the RPC isn't running, the server won't send back
	 * anything, so we don't know whether we need to expect something or
	 * not.
	 *
	 * To summarize: if we were to send a cancellation request, we would not
	 * know whether to expect a response, and it's possible that we would
	 * inadvertently invoke the same RPC again (which could be very
	 * destructive) or leak resources in the remote server.  For now, we
	 * punt and declare that request abortion is purely a client-side
	 * convenience that directs the client to stop doing anything with
	 * messages for this request.  We won't actually ask the server to stop
	 * doing anything.
	 */
	this.fc_aborted[request.frq_msgid] = request;
	this.requestFail(request, new VError({
	    'name': 'RequestAbortedError',
	    'cause': error
	}, 'request aborted'));
};

/*
 * Mark the given request as completed with the specified error.
 */
FastClient.prototype.requestFail = function (request, error)
{
	mod_assertplus.ok(request.frq_error === null);
	mod_assertplus.object(error);

	request.frq_error = new VError({
	    'name': error.name,
	    'cause': error,
	    'info': {
		'rpcMsgid': request.frq_msgid,
		'rpcMethod': request.frq_rpcmethod
	    }
	});

	this.requestComplete(request);

	/*
	 * We may be called in the context of a user action (e.g., if they
	 * issued a request while the transport was disconnected, or if they're
	 * aborting a request).  Defer the 'error' event so they don't have to
	 * deal with it being emitted synchronously during the execution of that
	 * action.
	 */
	setImmediate(function () {
		request.emit('error', request.frq_error);
	});
};

/*
 * Mark the given request as completed.
 */
FastClient.prototype.requestComplete = function (request)
{
	var msgid;

	msgid = request.frq_msgid;
	mod_assertplus.ok(!this.requestIsPending(request));
	mod_assertplus.ok(this.fc_pending[msgid] == request);
	delete (this.fc_pending[msgid]);
	this.fc_nrpc_done++;

	this.fc_recentrpc.push(request);
	if (this.fc_recentrpc.length > this.fc_nrecent) {
		this.fc_recentrpc.shift();
	}
};

FastClient.prototype.onMessage = function (message)
{
	var request, aborted, cause;

	this.fc_log.trace(message, 'incoming message');

	mod_assertplus.number(message.msgid,
	    'decoder provided message with no msgid');
	if (this.fc_pending.hasOwnProperty(message.msgid)) {
		request = this.fc_pending[message.msgid];
		mod_assertplus.ok(!request.frq_aborted);
		aborted = false;
	} else if (this.fc_aborted.hasOwnProperty(message.msgid)) {
		request = this.fc_aborted[message.msgid];
		mod_assertplus.ok(request.frq_aborted);
		aborted = true;
	} else {
		this.fatalError(new VError({
		    'name': 'FastProtocolError',
		    'info': {
			'fast_reason': 'unknown_msgid',
			'fast_msgid': message.msgid
		    }
		}, 'fast protocol: received message with unknown msgid %d',
		    message.msgid));
		return;
	}

	mod_assertplus.ok(!request.frq_done_graceful);
	request.frq_last = message;

	/*
	 * "end" messages are always meaningful because they allow us to clean
	 * up both normal and aborted requests.
	 */
	if (message.status == mod_protocol.FP_STATUS_END) {
		if (aborted) {
			this.fc_log.trace({
			    'msgid': request.frq_msgid
			}, 'cleaning up aborted request');
			delete (this.fc_aborted[request.frq_msgid]);
		} else {
			request.frq_done_graceful = true;
			this.requestComplete(request);
			request.end();
		}

		return;
	}

	/*
	 * If the request was aborted, then ignore all other messages.
	 */
	if (aborted) {
		this.fc_log.trace(message,
		    'ignoring incoming message (request aborted)');
		request.frq_nignored++;
		return;
	}

	/*
	 * The only reasons we can have an error are because we never sent the
	 * request out at all (which can never result in us getting here), we
	 * aborted the request (which we handled above), or the server already
	 * sent us an error (in which case we also shouldn't be able to get
	 * here).
	 */
	mod_assertplus.ok(request.frq_error === null);

	if (message.status == mod_protocol.FP_STATUS_DATA) {
		request.frq_ndata++;
		message.data.d.forEach(function (d) { request.push(d); });
		return;
	}

	mod_assertplus.equal(message.status, mod_protocol.FP_STATUS_ERROR,
	    'decoder emitted message with invalid status');
	cause = new VError({
	    'name': message.data.d.name,
	    'info': {
		'rpcMsgid': request.frq_msgid,
		'rpcMethod': request.frq_rpcmethod,
	        'context': message.data.d.context || {},
		/* XXX what's this field all about? */
		'errors': message.data.d.ase_errors || []
	    }
	}, '%s', message.data.d.message);
	request.frq_done_graceful = true;
	this.requestFail(request, new VError(cause, 'server error'));
};

FastClient.prototype.requestIsPending = function (request)
{
	mod_assertplus.object(request, 'request');
	mod_assertplus.ok(request instanceof mod_client_request.FastRpcRequest,
	    'request is not a FastRpcRequest');
	return (!request.frq_done_graceful && request.frq_error === null);
};
