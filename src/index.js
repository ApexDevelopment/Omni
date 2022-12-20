const fs = require("fs");
const ip6addr = require("ip6addr");
const { v4: uuidv4 } = require("uuid");
const { MemorySource } = require("@orbit/memory");
const { WebSocket, WebSocketServer } = require("ws");
const { JSONAPISource } = require("@orbit/jsonapi");
const { IndexedDBSource } = require("@orbit/indexeddb");
const {
	Coordinator,
	RequestStrategy,
	SyncStrategy
} = require("@orbit/coordinator");

const { EventBus } = require("./events");
const schema = require("./schema");

/**
 * Creates a new instance of an Omni server.
 * @param {Object} settings The settings for this Omni server.
 * @returns {Promise<Object>} The Omni server object, which contains all the
 *                            functions for interacting with the server.
 */
async function create(settings = {}) {
	// The in-memory database.
	let database = new MemorySource({
		schema,
		name: "memory"
	});

	// The coordinator, which handles syncing between the in-memory database
	// and the backing store. This is only used if a backing store is defined.
	// It is provided by the @orbit/coordinator package.
	let coordinator = new Coordinator();
	coordinator.addSource(database);

	// An object that contains all the pending pair requests, both incoming and
	// outgoing.
	let pending_pair_requests = {
		incoming: {},
		outgoing: []
	};

	// If a backing store is defined, create the coordinator and add the
	// synchronization strategies.
	if (settings.json_api) {
		if (fetch === undefined) {
			try {
				global.fetch = require("node-fetch");
			}
			catch (e) {
				throw "Please manually install the node-fetch package.";
			}
		}
		
		let backing_store = new JSONAPISource({
			schema,
			name: "remote",
			host: settings.json_api.host,
			namespace: settings.json_api.namespace
		});
		
		coordinator.addSource(backing_store);
		// When we query the in-memory database, we want to query the backing
		// store in the background, and then sync the results to the in-memory
		// database.
		coordinator.addStrategy(new RequestStrategy({
			source: "memory",
			on: "beforeQuery",
			target: "remote",
			action: "query",
			blocking: false
		}));
		// When we update the in-memory database, we want to update the backing
		// store in the background.
		coordinator.addStrategy(new RequestStrategy({
			source: "memory",
			on: "beforeUpdate",
			target: "remote",
			action: "update",
			blocking: false
		}));
		// When the backing store is updated, we want to sync the results to
		// the in-memory database.
		coordinator.addStrategy(new SyncStrategy({
			source: "remote",
			target: "memory",
			blocking: false
		}));
	}
	if (settings.use_indexeddb) {
		if (indexedDB === undefined) {
			try {
				global.indexedDB = require("indexeddb");
			}
			catch (e) {
				throw "Please manually install the indexeddb package.";
			}
		}

		let local_store = new IndexedDBSource({
			schema,
			name: "local",
			namespace: "omni"
		});

		coordinator.addSource(local_store);

		coordinator.addStrategy(new SyncStrategy({
			source: "memory",
			target: "local",
			blocking: false
		}));
	}
	
	await coordinator.activate();

	// The WebSocket server, which is used for peer-to-peer communication.
	let wss = null;
	// An object that contains all the peer connections, indexed by their
	// Omni peer ID.
	let peer_connections = {};
	// An object that contains all the users that are currently online, indexed
	// by their Omni user ID. The associated value is a boolean.
	let online_users = {};
	// The event bus, which is mainly used for sending events to whatever
	// application is using Omni.
	let event_bus = new EventBus();
	
	// The server's own information.
	let this_server = null;
	// The server's configuration. This is normally loaded from a config.json
	// file.
	let config = null;
	
	/**
	 * Creates a new Omni server Orbit record. Must be called before any other
	 * functions.
	 * @param {string} id This server's ID.
	 * @param {string} name This server's friendly name.
	 * @param {string} address This server's IP address.
	 * @param {number} port The port that this server is listening for peers on.
	 * @private
	 */
	function instantiate_server_information(id, name, address, port) {
		this_server = database.cache.query((q) =>
			q.findRecord({ type: "peer", id })
		);

		if (!this_server) {
			this_server = {
				type: "peer",
				id,
				attributes: {
					name,
					address,
					port
				},
				relationships: {
					channels: { data: [] },
					users: { data: [] }
				}
			}

			database.update((t) => t.addRecord(this_server));
		}
		else {
			if (this_server.attributes.name !== name) {
				database.update((t) =>
					t.replaceAttribute(this_server, "name", name)
				);
			}
			if (this_server.attributes.address !== address) {
				database.update((t) =>
					t.replaceAttribute(this_server, "address", address)
				);
			}
			if (this_server.attributes.port !== port) {
				database.update((t) =>
					t.replaceAttribute(this_server, "port", port)
				);
			}
		}
	}
	
	/**
	 * Finds a user by their username.
	 * @param {string} username The username to search for.
	 * @returns {Object|null} The user record, or null if no user was found.
	 * @private
	 */
	function find_user_by_username(username) {
		let users = database.cache.query((q) =>
			q
				.findRecords("user")
				.filter({ attribute: "username", value: username })
				.page({offset: 0, limit: 1})
		);
	
		if (users && users.length > 0) {
			return users[0];
		} else {
			return null;
		}
	}
	
	/**
	 * Creates a new local user.
	 * @param {string} username The username of the user to create.
	 * @param {boolean} admin Whether or not the user should be an admin.
	 * @returns Promise<string|null> The ID of the created user, or null if the
	 *          user already exists.
	 */
	async function create_user(username, admin = false) {
		if (find_user_by_username(username) != null) {
			return null;
		}
	
		const id = await create_user_internal(
			uuidv4(),
			username,
			admin,
			this_server.id
		);

		if (id != null) {
			for (let peer_id in peer_connections) {
				let socket = peer_connections[peer_id];
				socket.send(JSON.stringify({
					type: "create_user",
					id: id,
					username: username
				}));
			}
		}

		return id;
	}

	/**
	 * Creates a new user from any peer.
	 * @param {string} id The user's ID.
	 * @param {string} username The name of the user to create.
	 * @param {boolean} admin Whether or not the user should be an admin.
	 * @param {string} peer_id The ID of the peer that the user is on.
	 * @returns Promise<string|null> The ID of the created user, or null if the
	 *          user already exists.
	 * @private
	 */
	async function create_user_internal(id, username, admin, peer_id) {
		if (await get_user(id) != null) {
			return null;
		}
	
		let user = {
			type: "user",
			id,
			attributes: { username, admin },
			relationships: {
				peer: { data: { type: "peer", id: peer_id } }
			}
		};
	
		await database.update((t) => t.addRecord(user));
		event_bus.emit("create_user", user);
		return id;
	}
	
	/**
	 * Deletes a user from this Omni server.
	 * @param {string} id The ID of the user to delete.
	 * @returns Promise<boolean> Whether or not the user was deleted.
	 */
	async function delete_user(id) {
		const success = await delete_user_internal(id, this_server.id);

		if (success) {
			// Inform peers of deletion.
			for (let peer_id in peer_connections) {
				let socket = peer_connections[peer_id];
				socket.send(JSON.stringify({
					type: "delete_user",
					id: id
				}));
			}
		}

		return success;
	}

	/**
	 * Deletes a user from any peer.
	 * @param {string} id The ID of the user to delete.
	 * @param {string} peer_id The ID of the peer that the user is on.
	 * @returns Promise<boolean> Whether or not the user was deleted.
	 * @private
	 */
	async function delete_user_internal(id, peer_id) {
		let user = await get_user(id);
		if (user == null || user.relationships.peer.data.id !== peer_id) {
			return false;
		}

		await database.update((t) => t.removeRecord({ type: "user", id }));
		event_bus.emit("delete_user", id);
		return true;
	}
	
	/**
	 * Gets a user from this Omni server by their ID.
	 * @param {string} id The ID of the user to get.
	 * @returns {Promise<Object|null>} The user record, or null if no user was found.
	 */
	async function get_user(id) {
		return (await database.query((q) => q.findRecord({
			type: "user",
			id
		}))) || null;
	}
	
	/**
	 * Logs in a user.
	 * @param {string} id The ID of the user to login.
	 * @returns {Promise<boolean>} Whether or not the user was successfully logged in.
	 */
	async function login_user(id) {
		let user = await get_user(id);
	
		if (!user) {
			return false;
		}

		// Inform peers of login.
		if (user.relationships.peer.data.id == this_server.id) {
			for (let peer_id in peer_connections) {
				let socket = peer_connections[peer_id];
				socket.send(JSON.stringify({
					type: "login",
					id: id
				}));
			}
		}
	
		online_users[id] = true;
		event_bus.emit("user_online", user);
		return true;
	}
	
	/**
	 * Logs a user out.
	 * @param {string} id The ID of the user to logout.
	 * @returns {Promise<boolean>} Whether or not the user was successfully logged out.
	 */
	async function logout_user(id) {
		let user = await get_user(id);
	
		if (!user || !online_users[id]) {
			return false;
		}

		// Inform peers of logout.
		if (user.relationships.peer.data.id == this_server.id) {
			for (let peer_id in peer_connections) {
				let socket = peer_connections[peer_id];
				socket.send(JSON.stringify({
					type: "login",
					id: id
				}));
			}
		}
	
		delete online_users[id];
		event_bus.emit("user_offline", user);
		return true;
	}
	
	/**
	 * Gets an array of IDs for the users that are currently online.
	 * @returns {string[]} An array of all online user IDs.
	 */
	function get_all_online_users() {
		return Object.keys(online_users);
	}

	/**
	 * Gets an array of IDs for all users whose accounts were created on this
	 * server.
	 * @returns {Promise<string[]>} An array of all local user IDs.
	 */
	async function get_all_local_users() {
		let local_users = [];
	
		let users = await database.query((q) => q.findRecords("user"));
		// TODO: Probably could use Orbit filtering here
		for (let user of users) {
			if (user.relationships.peer.data.id == this_server.id) {
				local_users.push(user);
			}
		}
	
		return local_users;
	}
	
	/**
	 * Gets an array of IDs for all users whose accounts were created on this
	 * server and who are currently online.
	 * @returns {Promise<string[]>} An array of all online local user IDs.
	 */
	async function get_all_online_local_users() {
		let online_local_users = [];
	
		for (let user_id in online_users) {
			let user = await get_user(user_id);
			if (user.relationships.peer.data.id == this_server.id) {
				online_local_users.push(user);
			}
		}
	
		return online_local_users;
	}
	
	/**
	 * Gets an array of IDs for all users whose accounts were created on a
	 * remote server and who are currently online.
	 * @returns {Promise<string[]>} An array of all online remote user IDs.
	 */
	async function get_all_online_remote_users() {
		let online_remote_users = [];
	
		for (let user_id in online_users) {
			let user = await get_user(user_id);
			if (user.relationships.peer.data.id != this_server.id) {
				online_remote_users.push(user);
			}
		}
	
		return online_remote_users;
	}
	
	/**
	 * Gets an array of IDs for all users who are currently online in a given
	 * channel. Potentially includes users from remote servers.
	 * @param {string} channel_id The ID of the channel to get online users for.
	 * @returns {Promise<string[]>} An array of all online users in the channel.
	 */
	async function get_online_users(channel_id) {
		let channel = await get_channel(channel_id);

		if (!channel) {
			return [];
		}
	
		let online_users_in_channel = [];
	
		for (let user_id in online_users) {
			let user = await get_user(user_id);
			
			// Don't allow remote users to see private channels.
			if (user.relationships.peer.data.id != this_server.id
				&& channel.attributes.is_private) {
				continue;
			}

			// Don't allow non-admins to see admin-only channels.
			if (user.attributes.admin || !channel.attributes.admin_only) {
				online_users_in_channel.push(user);
			}
		}
	
		return online_users_in_channel;
	}
	
	/**
	 * Gets an array of IDs for all users whose accounts were created on this
	 * server and who are currently online in a given channel.
	 * @param {string} channel_id The ID of the channel to get online users for.
	 * @returns {Promise<string[]>} An array of all online local users in the
	 *                              channel.
	 */
	async function get_online_local_users(channel_id) {
		let channel = await get_channel(channel_id);

		if (!channel) {
			return [];
		}
	
		let online_local_users = [];
	
		for (let user_id in online_users) {
			let user = await get_user(user_id);
			if (user.relationships.peer.data.id == this_server.id
				&& (user.attributes.admin || !channel.attributes.admin_only)) {
				online_local_users.push(user);
			}
		}
	
		return online_local_users;
	}
	
	/**
	 * Gets an array of IDs for all users whose accounts were created on a
	 * remote server and who are currently online in a given channel.
	 * @param {string} channel_id The ID of the channel to get online users for.
	 * @returns {Promise<string[]>} An array of all online remote users in the
	 *                              channel.
	 */
	async function get_online_remote_users(channel_id) {
		let channel = await get_channel(channel_id);

		if (!channel || channel.attributes.is_private) {
			return [];
		}
		
		let online_remote_users = [];
	
		for (let user_id in online_users) {
			let user = await get_user(user_id);
			if (user.relationships.peer.data.id != this_server.id
				&& (user.attributes.admin || !channel.attributes.admin_only)) {
				online_remote_users.push(user);
			}
		}
	
		return online_remote_users;
	}
	
	/**
	 * Gets an array of all channels in the database, including remote channels.
	 * @returns {Promise<Object[]>} An array of all channels in the database,
	 *                              including remote channels, sorted by
	 *                              creation time.
	 */
	async function get_all_channels() {
		return (await database.query((q) => q.findRecords("channel")))
			.sort((a, b) => {
				// Sort by creation time.
				return a.attributes.timestamp - b.attributes.timestamp;
			}
		);
	}
	
	/**
	 * Gets an array of all channels in the database that were created on this
	 * server.
	 * @returns {Promise<Object[]>} An array of all local channels in the
	 *                              database, sorted by creation time.
	 */
	async function get_all_local_channels() {
		return (await database.query((q) =>
			q
				.findRecords("channel")
				.filter({
					relation: "peer",
					record: { type: "peer", id: this_server.id }
				})
		)).sort((a, b) => {
			return a.attributes.timestamp - b.attributes.timestamp;
		});
	}
	
	/**
	 * Get a channel by its ID.
	 * @param {string} id The ID of the channel to get.
	 * @returns {Promise<Object|null>} The channel with the given ID, or null if
	 *                                 no such channel exists.
	 */
	async function get_channel(id) {
		return (await database.query((q) =>
			q.findRecord({ type: "channel", id })
		)) || null;
	}
	
	/**
	 * Get a channel by its name.
	 * @param {string} name The name of the channel to find.
	 * @returns {Promise<Object|null>} The channel with the given name, or null
	 *                                 if no such channel exists.
	 * @private
	 */
	async function find_channel_by_name(name) {
		let channels = await database.query((q) =>
			q
				.findRecords("channel")
				.filter({ attribute: "name", value: name })
		);

		if (channels && channels.length > 0) {
			return channels[0];
		}
		else {
			return null;
		}
	}
	
	/**
	 * Creates a new channel.
	 * @param {string} name The name of the channel to create.
	 * @param {boolean} admin_only Whether the channel is admin-only.
	 * @param {boolean} is_private Whether the channel is visible to remote
	 *                             users.
	 * @returns {Promise<string|null>} The ID of the newly-created channel, or
	 *                                 null if a channel with the given name
	 *                                 already exists.
	 */
	async function create_channel(name, admin_only = false, is_private = false) {
		if (await find_channel_by_name(name)) {
			return null;
		}
	
		const timestamp = Date.now();
		const id = await create_channel_internal(
			uuidv4(),
			name,
			admin_only,
			is_private,
			timestamp,
			this_server.id
		);

		// TODO: Still need to decide whether admin-only channels should be
		// visible to remote users (perhaps if the user is an admin on the
		// remote server?).
		if (id && !is_private && !admin_only) {
			// Tell peers about the new channel.
			for (let peer_id in peer_connections) {
				let socket = peer_connections[peer_id];
				socket.send(JSON.stringify({
					type: "channel_create",
					id,
					name,
					timestamp
				}));
			}
		}

		return id;
	}
	
	/**
	 * Creates a new channel from any peer.
	 * @param {string} id The ID of the channel to create.
	 * @param {string} name The name of the channel to create.
	 * @param {boolean} admin_only Whether the channel is admin-only.
	 * @param {boolean} is_private Whether the channel is visible to remote
	 *                             users.
	 * @param {number} timestamp The creation time of the channel.
	 * @param {string} peer_id The ID of the peer that created the channel.
	 * @returns {Promise<string|null>} The ID of the newly-created channel, or
	 *                                 null if a channel with the given name
	 *                                 already exists.
	 * @private
	 */
	async function create_channel_internal(id, name, admin_only, is_private, timestamp, peer_id) {
		// Check if channel exists first.
		if (await get_channel(id)) {
			return null;
		}
	
		let channel = {
			type: "channel",
			id,
			attributes: {
				name,
				admin_only,
				is_private,
				timestamp
			},
			relationships: {
				peer: { data: { type: "peer", id: peer_id } }
			}
		}

		await database.update((t) => t.addRecord(channel));
		event_bus.emit("channel_create", channel);
		return channel.id;
	}
	
	/**
	 * Deletes a channel.
	 * @param {string} id The ID of the channel to delete.
	 * @returns {Promise<boolean>} Whether the channel was deleted.
	 */
	async function delete_channel(id) {
		let channel = await get_channel(id);

		if (!channel) {
			return false;
		}

		const success = await delete_channel_internal(id, this_server.id);

		if (success) {
			if (!channel.attributes.is_private
				&& !channel.attributes.admin_only) {
				// Tell peers about channel deletion
				for (let peer_id in peer_connections) {
					let socket = peer_connections[peer_id];
					socket.send(JSON.stringify({
						type: "channel_delete",
						id: channel.id
					}));
				}
			}
		}

		return success;
	}

	/**
	 * Deletes a channel from any peer.
	 * @param {string} id The ID of the channel to delete.
	 * @param {string} peer_id The ID of the peer that created the channel.
	 * @returns Promise<boolean> Whether the channel was deleted.
	 */
	async function delete_channel_internal(id, peer_id) {
		let channel = await get_channel(id);
	
		if (!channel || channel.relationships.peer.data.id != peer_id) {
			return false;
		}
	
		// Also delete all associated messages
		// UNTESTED
		/*let messages = await database.query(
			q
				.findRecords("message")
				.filter({
					relation: "channel",
					record: { type: "channel", id: channel_id }
				})
		);

		for (let message of messages) {
			database.update((t) => t.removeRecord({ type: "message", id: message.id }));
		}*/
	
		await database.update((t) => t.removeRecord({ type: "channel", id }));
		event_bus.emit("channel_delete", id);
		return true;
	}

	/**
	 * Gets a message by its ID.
	 * @param {string} id The ID of the message to get.
	 * @returns {Promise<Object|null>} The message, or null if it doesn't exist.
	 */
	async function get_message(id) {
		return (await database.query((q) => q.findRecord({
			type: "message",
			id
		}))) || null;
	}
	
	/**
	 * Sends a message to a channel from a user.
	 * @param {string} user_id The ID of the user who sent the message.
	 * @param {string} channel_id The ID of the channel to send the message to.
	 * @param {string} content The content of the message.
	 * @returns {Promise<Object|null>} The message, or null if the channel or
	 *                                 user doesn't exist, or if the user does
	 *                                 not have permission to send messages to
	 *                                 the channel.
	 */
	async function send_message(user_id, channel_id, content) {
		let user = await get_user(user_id);
		let channel = await get_channel(channel_id);
	
		// Make sure the channel exists and that the user is logged in
		if (!channel || !online_users[user_id]) {
			return null;
		}

		// Make sure the user is allowed to send messages to this channel
		if (channel.attributes.admin_only && !user.attributes.admin) {
			return null;
		}
	
		let message = {
			type: "message",
			id: uuidv4(),
			attributes: {
				content: content,
				timestamp: Date.now()
			},
			relationships: {
				user: { data: { type: "user", id: user_id } },
				channel: { data: { type: "channel", id: channel_id } }
			}
		};

		// If this message was sent from a local user we need to tell peers
		// about it
		if (user.relationships.peer.data.id == this_server.id
			&& !channel.attributes.is_private) {
			for (let peer_id in peer_connections) {
				// Only send to peers that we know can see the channel.
				if (channel.relationships.peer.data.id == this_server.id
					|| channel.relationships.peer.data.id == peer_id) {
					let socket = peer_connections[peer_id];

					socket.send(JSON.stringify({
						type: "send_message",
						user_id,
						channel_id,
						content,
						timestamp: message.attributes.timestamp
					}));
				}
			}
		}
	
		await database.update((t) => t.addRecord(message));

		let recipients = await get_online_local_users(channel_id);

		event_bus.emit("message", {
			message,
			recipients
		});
		
		return message.id;
	}

	/**
	 * Sends a message to a channel from a user on a remote server.
	 * @param {string} user_id The ID of the user who sent the message.
	 * @param {string} channel_id The ID of the channel to send the message to.
	 * @param {string} content The content of the message.
	 * @param {string} message_id The ID of the message.
	 * @param {number} timestamp The time the message was sent.
	 * @returns {Promise<Object|null>} The message, or null if the channel or
	 *                                 user doesn't exist, or if the user does
	 *                                 not have permission to send messages to
	 *                                 the channel.
	 * @private
	 */
	async function send_remote_message(user_id, channel_id, content, message_id, timestamp) {
		let channel = await get_channel(channel_id);

		if (!channel || !online_users[user_id]) {
			return null;
		}

		if (channel.attributes.admin_only || channel.attributes.is_private) {
			return null;
		}

		let message = {
			type: "message",
			id: message_id,
			attributes: {
				content,
				timestamp
			},
			relationships: {
				user: { data: { type: "user", id: user_id } },
				channel: { data: { type: "channel", id: channel_id } }
			}
		}

		await database.update((t) => t.addRecord(message));

		let recipients = await get_online_local_users(channel_id);

		event_bus.emit("message", {
			message,
			recipients
		});

		return message.id;
	}
	
	/**
	 * Deletes a message.
	 * @param {string} id The ID of the message to delete.
	 */
	async function delete_message(id) {
		let message = await get_message(id);
		let channel = await get_channel(message.relationships.channel.data.id);
		await database.update((t) => t.removeRecord({ type: "message", id }));

		if (channel.relationships.peer.data.id == this_server.id
			&& !channel.attributes.is_private
			&& !channel.attributes.admin_only) {
			for (let peer_id in peer_connections) {
				let socket = peer_connections[peer_id];
				socket.send(JSON.stringify({
					type: "message_delete",
					id
				}));
			}
		}

		let recipients = await get_online_local_users(channel.id);

		event_bus.emit("message_delete", {
			message,
			recipients
		});
	}

	/**
	 * Deletes a message sent from a remote server.
	 * @param {string} id The ID of the message to delete.
	 * @param {string} peer_id The ID of the peer that sent the message.
	 * @returns {Promise<void>} A promise that resolves when the message has
	 *                          been deleted.
	 * @private
	 */
	async function delete_remote_message(id, peer_id) {
		let message = await get_message(id);
		let channel = await get_channel(message.relationships.channel.data.id);

		if (channel.relationships.peer.data.id != peer_id
			|| channel.attributes.is_private || channel.attributes.admin_only) {
			return;
		}

		await database.update((t) => t.removeRecord({ type: "message", id }));
		event_bus.emit("message_delete", id);
	}
	
	/**
	 * Gets messages from a channel.
	 * @param {string} channel_id The ID of the channel to get messages from.
	 * @param {number} timestamp The timestamp to get messages before.
	 * @param {number} limit The maximum number of messages to get.
	 * @returns {Promise<Array<Object>>} An array of messages.
	 */
	async function get_messages(channel_id, timestamp, limit = 50) {
		let channel = await get_channel(channel_id);
	
		if (!channel) {
			return null;
		}
	
		return (await database.query((q) =>
			q
				.findRecords("message")
				.filter({
					relation: "channel",
					record: { type: "channel", id: channel_id }
				})
		))
			// Annoyingly, I couldn't get this filter to work in the query.
			.filter((message) => message.attributes.timestamp < timestamp)
			.sort((a, b) => a.attributes.timestamp - b.attributes.timestamp)
			.slice(0, limit);
	}

	/**
	 * Gets a peer.
	 * @param {string} id The ID of the peer.
	 * @returns {Promise<Object|null>} The peer, or null if it doesn't exist.
	 */
	async function get_peer(id) {
		return (await database.query((q) => q.findRecord({
			type: "peer",
			id
		}))) || null;
	}
	
	/**
	 * Alerts the server that a peer is online.
	 * @param {string} peer_id The ID of the peer.
	 * @param {WebSocket} socket The socket that the peer is connected on.
	 * @returns {Promise<boolean>} Whether the peer was successfully marked as
	 *                             online.
	 * @private
	 */
	async function peer_online(peer_id, socket) {
		let peer = await get_peer(peer_id);
		if (!peer) {
			return false;
		}
	
		peer_connections[peer_id] = socket;
		event_bus.emit("peer_online", peer);
		return true;
	}

	/**
	 * Adds a peer to the database.
	 * @param {string} id The ID of the peer.
	 * @param {string} name The name of the peer.
	 * @param {string} address The IP address of the peer.
	 * @param {number} port The port of the peer.
	 * @returns {Promise<void>} A promise that resolves when the peer has been
	 *                          added.
	 * @private
	 */
	async function add_peer(id, name, address, port) {
		let peer = {
			type: "peer",
			id,
			attributes: {
				name,
				address,
				port
			},
			relationships: {
				channels: { data: [] },
				users: { data: [] }
			}
		};
	
		await database.update((t) => t.addRecord(peer));
	}
	
	/**
	 * Starts listening for events from a peer. This is used for synchronization
	 * of data between servers.
	 * @param {string} peer_id The ID of the peer.
	 * @param {WebSocket} websocket The websocket that the peer is connected on.
	 * @private
	 */
	function set_up_handlers(peer_id, websocket) {
		// Wait for messages from the peer.
		websocket.on("message", async (message) => {
			let data = JSON.parse(message);
	
			switch (data.type) {
				case "login": {
					// Should be fine?
					login_user(data.id);
					break;
				}
				case "logout": {
					// Should be fine?
					logout_user(data.id);
					break;
				}
				case "create_user": {
					create_user_internal(
						data.id,
						data.username,
						false,
						peer_id
					);
					break;
				}
				case "delete_user": {
					delete_user_internal(data.id, peer_id);
					break;
				}
				case "channel_create": {
					create_channel_internal(
						data.id,
						data.name,
						false,
						false,
						data.timestamp,
						peer_id
					);

					break;
				}
				case "channel_delete": {
					delete_channel_internal(data.id, peer_id);
					break;
				}
				case "send_message": {
					send_remote_message(
						data.user_id,
						data.channel_id,
						data.content,
						data.message_id,
						data.timestamp
					);
					break;
				}
				case "delete_message": {
					delete_remote_message(data.id, peer_id);
					break;
				}
				// TODO: Currently unused. Should be used to sync message
				// backlog.
				case "get_messages": {
					let messages = await get_messages(
						data.channel_id,
						data.timestamp,
						data.limit
					);

					websocket.send(JSON.stringify({
						type: "get_messages_success",
						messages: messages
					}));
					break;
				}
				default:
					console.log(`Unknown message "${data.type}" from peer ${peer_id}`);
			}
		});
	}
	
	/**
	 * Sends a pair request to a peer.
	 * @param {string} ip The IP address of the peer to pair with.
	 * @param {number} port The port of the peer to pair with.
	 * @returns {boolean} Whether the pair request was sent.
	 */
	function send_pair_request(ip, port) {
		ip = ip6addr.parse(ip).toString({ format: "v4" });

		if (ip == this_server.attributes.address
			&& port == this_server.attributes.port) {
			return false;
		}

		if (pending_pair_requests.outgoing.find((pair_request) => {
			return pair_request.ip == ip && pair_request.port == port;
		})) {
			return false;
		}

		let socket = new WebSocket("ws://" + ip + ":" + port);
	
		socket.on("open", () => {
			socket.send(JSON.stringify({
				type: "pair_request",
				id: this_server.id,
				name: this_server.attributes.name,
				address: socket._socket.localAddress,
				port: this_server.attributes.port
			}));

			pending_pair_requests.outgoing.push({ socket, ip, port });
			socket.close();
		});

		return true;
	}

	/**
	 * Tells a peer about all the channels and users on this server.
	 * @param {string} id The ID of the peer to inform.
	 * @returns {Promise<boolean>} Whether the peer was informed.
	 * @private
	 */
	async function inform_peer(id) {
		if (!peer_connections[id]) return false;
		let socket = peer_connections[id];
		let channels = await get_all_local_channels();
		let users = await get_all_local_users();

		for (let channel of channels) {
			if (!channel.attributes.admin_only
				&& !channel.attributes.is_private) {
				socket.send(JSON.stringify({
					type: "channel_create",
					id: channel.id,
					name: channel.attributes.name,
					timestamp: channel.attributes.timestamp
				}));
			}
		}

		for (let user of users) {
			socket.send(JSON.stringify({
				type: "create_user",
				id: user.id,
				username: user.attributes.username
			}));
		}

		for (let user_id in online_users) {
			socket.send(JSON.stringify({
				type: "login",
				id: user_id
			}));
		}

		return true;
	}

	/**
	 * Responds to a pair request.
	 * @param {string} id The ID of the peer to respond to.
	 * @param {boolean} accepted Whether the pair request was accepted.
	 * @returns {Promise<boolean>} Whether the pair request was responded to.
	 */
	async function respond_to_pair_request(id, accepted) {
		let pair_request = pending_pair_requests.incoming[id];
		
		if (!pair_request) {
			return false;
		}

		if (accepted) add_peer(id, pair_request.name, pair_request.address, pair_request.port);
		let socket = new WebSocket("ws://" + pair_request.address + ":" + pair_request.port);

		socket.on("open", () => {
			socket.once("message", async (message) => {
				let data = JSON.parse(message);
				if (data.type == "handshake_ack") {
					console.log(`Paired with peer ${pair_request.name} (${id})`);
					await peer_online(id, socket);
					set_up_handlers(id, socket);
					inform_peer(id);
				}
			});

			socket.send(JSON.stringify({
				type: accepted ? "pair_accept" : "pair_reject",
				id: this_server.id,
				name: this_server.attributes.name,
				address: socket._socket.localAddress,
				port: this_server.attributes.port
			}));
		});

		socket.on("error", (error) => {
			console.log(error);
		});

		return true;
	}
	
	/**
	 * Checks whether a peer exists.
	 * @param {string} id The ID of the peer to check.
	 * @returns {Promise<boolean>} Whether the peer exists.
	 * @private
	 */
	async function has_peer(id) {
		return (await database.query((q) => q.findRecords("peer").filter({ attribute: "id", value: id }))).length > 0;
	}

	/**
	 * Try to connect to a peer.
	 * @param {string} peer The ID of the peer to connect to.
	 * @returns {boolean} Whether a connection attempt was made.
	 * @private
	 */
	function connect_to_peer(peer) {
		if (peer.id == this_server.id) {
			return false;
		}
	
		if (peer_connections[peer.id]) {
			return false;
		}
	
		let socket = new WebSocket(`ws://${peer.attributes.address}:${peer.attributes.port}/`);
	
		socket.on("open", () => {
			socket.once("message", async (message) => {
				let data = JSON.parse(message);
				if (data.type == "handshake_ack") {
					console.log(`Connected to peer ${peer.attributes.name} (${peer.id})`);
					await peer_online(peer.id, socket);
					set_up_handlers(id, socket);
					inform_peer(id);
				}
			});

			socket.send(JSON.stringify({
				type: "handshake",
				id: this_server.id
			}));
		});
	
		return true;
	}
	
	/**
	 * Waits for a handshake or pair request from a socket.
	 * @param {string} socket The socket to await a handshake or pair request
	 *                        on.
	 * @returns {Promise<Object|string>} The handshake or pair request data.
	 * @private
	 */
	function await_handshake_or_pair_request(socket) {
		return new Promise((resolve, reject) => {
			socket.on("message", (message) => {
				let data = JSON.parse(message);
				let address = ip6addr.parse(socket._socket.remoteAddress).toString({ format: "v4" });
				data.address = address;
	
				if (data.type == "handshake") {
					resolve(data);
				}
				else if (data.type == "pair_accept" && pending_pair_requests.outgoing.findIndex((request) => request.ip == address && request.port == data.port) != -1) {
					pending_pair_requests.outgoing = pending_pair_requests.outgoing.filter((request) => request.ip != address && request.port != data.port);
					add_peer(data.id, data.name, data.address, data.port).then(() => {
						event_bus.emit("pair_accept", data);
						resolve(data);
					});
				}
				else if (data.type == "pair_reject" && pending_pair_requests.outgoing.findIndex((request) => request.ip == address && request.port == data.port) != -1) {
					pending_pair_requests.outgoing = pending_pair_requests.outgoing.filter((request) => request.ip != address && request.port != data.port);
					event_bus.emit("pair_reject", data);
					reject("Pair request rejected");
				}
				else if (data.type == "pair_request") {
					has_peer(data.id).then((is_peer) => {
						if (is_peer) {
							socket.send(JSON.stringify({
								type: "pair_reject"
							}));
						}
						else {
							pending_pair_requests.incoming[data.id] = { name: data.name, address: address, port: data.port };
							event_bus.emit("pair_request", data);
							reject(`Server ${address}:${data.port} is not yet paired, awaiting pair approval from admin to continue`);
						}
					});
				}
				else {
					reject(data);
				}
			});
		});
	}
	
	/**
	 * Starts the Omni server.
	 * @param {string} config_path The path to the config file.
	 */
	function start(config_path) {
		config = JSON.parse(fs.readFileSync(config_path, "utf8"));
		instantiate_server_information(
			config.server_id,
			config.server_name,
			"127.0.0.1",
			config.server_port
		);

		// Wait for new connections to the server.
		wss = new WebSocketServer({ port: config.server_port });
		wss.on("connection", (ws, req) => {
			// Wait for the handshake message...
			await_handshake_or_pair_request(ws).then((data) => {
				// If we get a valid handshake, mark the peer as online and set
				// up handlers.
				peer_online(data.id, ws);
				set_up_handlers(data.id, ws);

				// Send a handshake acknowledgement.
				ws.send(JSON.stringify({
					type: "handshake_ack"
				}), () => {
					inform_peer(data.id);
				});
			}).catch((err) => {
				// If we get an error, close the connection. This can also
				// happen if the peer is not paired. In that case, we receive
				// a pair request.
				console.log("Peer handshake error:", err);
				ws.close();
			});
		});
	
		// Log errors in connection.
		wss.on("error", (err) => {
			console.log(`Error in connection: ${err}`);
		});
	
		// Connect to all peers in Orbit database.
		database.query((q) => q.findRecords("peer")).then((peers) => {
			peers.forEach((peer) => {
				// Don't connect to self
				if (peer.id != this_server.id) {
					connect_to_peer(peer);
				}
			});
		});
	}
	
	/**
	 * Stops the Omni server, closing all connections.
	 */
	function stop() {
		if (wss != null) {
			wss.close();
			wss = null;
		}

		// Close all peer connections
		for (let peer_id in peer_connections) {
			let socket = peer_connections[peer_id];
			if (socket.readyState == WebSocket.OPEN
				|| socket.readyState == WebSocket.CONNECTING) {
				socket.close();
			}
		}
	}

	return {
		start, stop,
		on: event_bus.on, off: event_bus.off,

		get_message, send_message, get_messages, delete_message,
		create_channel, delete_channel,
		create_user, get_user, delete_user,
		login_user, logout_user,
		get_all_channels, get_channel,
		get_all_online_users, get_all_online_local_users, get_all_online_remote_users,
		get_online_users, get_online_local_users, get_online_remote_users,
		send_pair_request, respond_to_pair_request,
		get_peer,

		id: () => this_server.id,
		name: () => this_server.attributes.name,
		address: () => this_server.attributes.address,
		port: () => this_server.attributes.port
	}
}

module.exports = { create };