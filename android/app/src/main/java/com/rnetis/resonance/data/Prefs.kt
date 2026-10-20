package com.rnetis.resonance.data

import android.content.Context
import android.content.SharedPreferences
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONObject

/**
 * Everything the app needs to remember lives in one SharedPreferences file: the server
 * address, the username whose library we are looking at, and the index of tracks that
 * have been saved to this device.
 */
class Prefs(context: Context) {

    private val sp: SharedPreferences =
        context.applicationContext.getSharedPreferences("resonance", Context.MODE_PRIVATE)

    /** Absolute http(s) base URL without a trailing slash, e.g. `http://192.168.1.20:3130`. */
    var serverUrl: String
        get() = sp.getString(KEY_SERVER, "").orEmpty()
        set(value) {
            sp.edit().putString(KEY_SERVER, value).apply()
        }

    /** The username sent as `X-Resonance-User`; it selects which library is shown. */
    var username: String
        get() = sp.getString(KEY_USER, "").orEmpty()
        set(value) {
            sp.edit().putString(KEY_USER, value).apply()
        }

    val configured: Boolean get() = serverUrl.isNotBlank() && username.isNotBlank()

    /** track key -> absolute path of the copy on this device. */
    fun offlineIndex(): MutableMap<String, String> {
        val result = mutableMapOf<String, String>()
        val raw = sp.getString(KEY_OFFLINE, null) ?: return result
        runCatching {
            val obj = JSONObject(raw)
            val keys = obj.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                val value = obj.optString(key, "")
                if (value.isNotEmpty()) result[key] = value
            }
        }
        return result
    }

    fun offlinePath(key: String): String? = offlineIndex()[key]

    fun putOffline(key: String, path: String) {
        val index = offlineIndex()
        index[key] = path
        saveOffline(index)
    }

    fun removeOffline(key: String) {
        val index = offlineIndex()
        index.remove(key)
        saveOffline(index)
    }

    fun clearOfflineIndex() {
        sp.edit().remove(KEY_OFFLINE).apply()
    }

    private fun saveOffline(index: Map<String, String>) {
        val obj = JSONObject()
        for ((key, value) in index) obj.put(key, value)
        sp.edit().putString(KEY_OFFLINE, obj.toString()).apply()
    }

    companion object {
        private const val KEY_SERVER = "server_url"
        private const val KEY_USER = "username"
        private const val KEY_OFFLINE = "offline_index"

        fun offlineKey(user: String, trackPath: String): String = "$user|$trackPath"

        /**
         * `192.168.1.20:3130` -> `http://192.168.1.20:3130`
         * `http://host:3130/`  -> `http://host:3130`
         * Returns null when the value cannot be turned into an http(s) URL.
         */
        fun normalizeServer(input: String): String? {
            var value = input.trim()
            if (value.isEmpty()) return null
            if (!value.contains("://")) value = "http://$value"
            val lower = value.lowercase()
            if (!lower.startsWith("http://") && !lower.startsWith("https://")) return null
            value = value.trimEnd('/')
            if (value == "http:" || value == "https:" || value == "http:/" || value == "https:/") return null
            return if (value.toHttpUrlOrNull() == null) null else value
        }
    }
}
