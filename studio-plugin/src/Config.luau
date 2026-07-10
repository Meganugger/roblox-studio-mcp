--!strict
-- Static plugin configuration. Runtime settings (token, port) live in
-- plugin settings and are managed through the UI widget.

return {
	PLUGIN_VERSION = "2.0.0",
	PROTOCOL_VERSION = 2,
	DEFAULT_PORT = 3667,
	HOST = "127.0.0.1",

	-- Reconnect backoff (seconds)
	BACKOFF_INITIAL = 1,
	BACKOFF_MAX = 15,

	-- Output capture
	LOG_BUFFER_SIZE = 5000,

	-- Serialization limits
	MAX_TABLE_DEPTH = 6,
	MAX_TABLE_KEYS = 500,
}
