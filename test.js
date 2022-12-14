const Omni = require("./src/index.js");
let omni_server1;
let omni_server2;

/**
 * A quick note about the Jest framework:
 * Even though many of these tests are async, Jest will wait for each one to
 * finish before moving on to the next one. So, even though some of the tests
 * technically return immediately, we can still rely on the order of execution
 * to be correct.
 */

test("Omni exports properly", () =>{
	expect(Omni).toBeDefined();
	expect(Omni.create).toBeDefined();
});

test("Omni creates server properly", async () => {
	omni_server1 = await Omni.create();
	expect(omni_server1).toBeDefined();
	expect(omni_server1.start).toBeDefined();
	expect(omni_server1.stop).toBeDefined();
	expect(omni_server1.on).toBeDefined();
	expect(omni_server1.off).toBeDefined();
	expect(omni_server1.create_channel).toBeDefined();
	expect(omni_server1.create_user).toBeDefined();
	expect(omni_server1.delete_channel).toBeDefined();
	expect(omni_server1.delete_message).toBeDefined();
	expect(omni_server1.delete_user).toBeDefined();
	expect(omni_server1.get_all_channels).toBeDefined();
	expect(omni_server1.get_all_online_local_users).toBeDefined();
	expect(omni_server1.get_all_online_remote_users).toBeDefined();
	expect(omni_server1.get_all_online_users).toBeDefined();
	expect(omni_server1.get_channel).toBeDefined();
	expect(omni_server1.get_messages).toBeDefined();
	expect(omni_server1.get_online_local_users).toBeDefined();
	expect(omni_server1.get_online_remote_users).toBeDefined();
	expect(omni_server1.get_online_users).toBeDefined();
	expect(omni_server1.get_online_users).toBeDefined();
	expect(omni_server1.get_user).toBeDefined();
	expect(omni_server1.login_user).toBeDefined();
	expect(omni_server1.logout_user).toBeDefined();
	expect(omni_server1.send_message).toBeDefined();
	expect(omni_server1.send_pair_request).toBeDefined();
	expect(omni_server1.respond_to_pair_request).toBeDefined();

	expect(omni_server1.id).toBeDefined();
	expect(omni_server1.address).toBeDefined();
	expect(omni_server1.port).toBeDefined();
	expect(omni_server1.name).toBeDefined();
});

test("Omni starts without exceptions", () => {
	omni_server1.start("testconf1.json");
});

let user_id = null;
let channel_id = null;
test("Omni successfully creates a user", async () => {
	user_id = await omni_server1.create_user("test");
	expect(typeof(user_id)).toBe("string");
});

test("Omni prevents duplicate usernames", async () => {
	expect(await omni_server1.create_user("test")).toBe(null);
});

test("Omni successfully creates a channel", async () => {
	channel_id = await omni_server1.create_channel("test");
	expect(typeof(channel_id)).toBe("string");
});

test("Omni prevents duplicate channel names", async () => {
	expect(await omni_server1.create_channel("test")).toBe(null);
});

test("Omni successfully logs in a user", async () => {
	expect(await omni_server1.login_user(user_id)).toBe(true);
});

test("Omni prevents logging in with bogus ID", async () => {
	expect(await omni_server1.login_user("bogus")).toBe(false);
});

test("Omni successfully sends a message", (done) => {
	omni_server1.on("message", (data) => {
		expect(data).toBeDefined();
		expect(data.message).toBeDefined();
		expect(data.message.attributes).toBeDefined();
		expect(data.message.attributes.content).toBe("test");
		expect(data.message.relationships).toBeDefined();
		expect(data.message.relationships.user.data.id).toBe(user_id);
		done();
	});

	omni_server1.send_message(user_id, channel_id, "test").then((message_id) => {
		expect(typeof(message_id)).toBe("string");
	});
});

test("Omni successfully deletes a channel", async () => {
	expect(await omni_server1.delete_channel(channel_id)).toBe(true);
});

test("Starting another instance on a different port works", async () => {
	omni_server2 = await Omni.create();
	omni_server2.start("testconf2.json");
	expect(omni_server2.address()).toBe("localhost");
	expect(omni_server2.port()).toBe(7778);
});

test("Pairing works", (done) => {
	let one_server_done = false;

	omni_server1.on("peer_online", (data) => {
		expect(data).toBeDefined();
		expect(data.id).toBe(omni_server2.id());
		if (one_server_done) {
			done();
		} else {
			one_server_done = true;
		}
	});

	omni_server2.on("peer_online", (data) => {
		expect(data).toBeDefined();
		expect(data.id).toBe(omni_server1.id());
		if (one_server_done) {
			done();
		} else {
			one_server_done = true;
		}
	});

	omni_server1.on("pair_accept", (data) => {
		expect(data).toBeDefined();
		expect(data.id).toBe(omni_server2.id());
	});

	omni_server2.on("pair_request", async (data) => {
		expect(data).toBeDefined();
		expect(data.id).toBe(omni_server1.id());
		expect(await omni_server2.respond_to_pair_request(data.id, true)).toBe(true);
	});

	expect(omni_server1.send_pair_request("127.0.0.1", 7778)).toBe(true);
});

test("Omni successfully logs out a user", async () => {
	expect(await omni_server1.logout_user(user_id)).toBe(true);
});

test("Omni prevents logging out twice", async () => {
	expect(await omni_server1.logout_user(user_id)).toBe(false);
});

test("Omni prevents logging out with bogus ID", async () => {
	expect(await omni_server1.logout_user("bogus")).toBe(false);
});

test("Omni prevents getting a channel with bogus ID", async () => {
	expect(await omni_server1.get_channel("bogus")).toBe(null);
});

test("Omni prevents getting users in a channel with bogus ID", async () => {
	expect(await omni_server1.get_online_users("bogus")).toStrictEqual([]);
	expect(await omni_server1.get_online_local_users("bogus")).toStrictEqual([]);
	expect(await omni_server1.get_online_remote_users("bogus")).toStrictEqual([]);
});
	
test("Omni successfully stops", () => {
	omni_server1.stop();
	omni_server2.stop();
});