const Omni = require("./src/index.js");
let omni_server;

test("Omni exports properly", () =>{
	expect(Omni).toBeDefined();
	expect(Omni.create).toBeDefined();
});

test("Omni creates server properly", async () => {
	omni_server = await Omni.create();
	expect(omni_server).toBeDefined();
	expect(omni_server.start).toBeDefined();
	expect(omni_server.stop).toBeDefined();
	expect(omni_server.on).toBeDefined();
	expect(omni_server.off).toBeDefined();
	expect(omni_server.create_channel).toBeDefined();
	expect(omni_server.create_user).toBeDefined();
	expect(omni_server.delete_channel).toBeDefined();
	expect(omni_server.delete_message).toBeDefined();
	expect(omni_server.delete_user).toBeDefined();
	expect(omni_server.get_all_channels).toBeDefined();
	expect(omni_server.get_all_online_local_users).toBeDefined();
	expect(omni_server.get_all_online_remote_users).toBeDefined();
	expect(omni_server.get_all_online_users).toBeDefined();
	expect(omni_server.get_channel).toBeDefined();
	expect(omni_server.get_messages).toBeDefined();
	expect(omni_server.get_online_local_users).toBeDefined();
	expect(omni_server.get_online_remote_users).toBeDefined();
	expect(omni_server.get_online_users).toBeDefined();
	expect(omni_server.get_online_users).toBeDefined();
	expect(omni_server.get_user).toBeDefined();
	expect(omni_server.login_user).toBeDefined();
	expect(omni_server.logout_user).toBeDefined();
	expect(omni_server.send_message).toBeDefined();
	expect(omni_server.send_pair_request).toBeDefined();
});

test("Omni starts without exceptions", () => {
	omni_server.start("defaultconf.json");
});

let user_id = null;
test("Omni successfully creates a user", async () => {
	user_id = await omni_server.create_user("test");
	expect(typeof(user_id)).toBe("string");
});

test("Omni prevents duplicate usernames", async () => {
	expect(await omni_server.create_user("test")).toBe(null);
});

test("Omni successfully creates a channel", async () => {
	expect(typeof(await omni_server.create_channel("test"))).toBe("string");
});

test("Omni prevents duplicate channel names", async () => {
	expect(await omni_server.create_channel("test")).toBe(null);
});

test("Omni successfully logs in a user", async () => {
	expect(await omni_server.login_user(user_id)).toBe(true);
});

test("Omni prevents logging in with bogus ID", async () => {
	expect(await omni_server.login_user("bogus")).toBe(false);
});

test("Omni successfully stops", () => {
	omni_server.stop();
});