package com.rnetis.resonance.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/** Any non-2xx answer (or a transport failure) surfaces as this, with the server's own text. */
class ApiException(message: String, val status: Int = 0) : Exception(message)

/**
 * A thin handwritten client for the Resonance REST API. JSON is parsed with the
 * platform's org.json, so there is no serialization codegen anywhere.
 *
 * Every call takes the base URL and the username explicitly: the username is sent as
 * `X-Resonance-User` and decides whose library the server answers with.
 */
class Api(private val client: OkHttpClient) {

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    /** Joins a base URL with the server-relative path found in API payloads. */
    fun absolute(baseUrl: String, path: String?): String? {
        if (path.isNullOrBlank()) return null
        if (path.startsWith("http://") || path.startsWith("https://")) return path
        val base = baseUrl.trim().trimEnd('/')
        if (base.isEmpty()) return null
        return "$base/${path.trimStart('/')}"
    }

    private fun buildUrl(baseUrl: String, path: String, params: Map<String, String?> = emptyMap()): String {
        val full = absolute(baseUrl, path) ?: throw ApiException("No server address is configured")
        val parsed = full.toHttpUrlOrNull() ?: throw ApiException("Not a usable server address: $baseUrl")
        if (params.isEmpty()) return parsed.toString()
        val builder = parsed.newBuilder()
        for ((key, value) in params) {
            if (value != null) builder.addQueryParameter(key, value)
        }
        return builder.build().toString()
    }

    private fun execute(method: String, url: String, user: String?, body: JSONObject?): String {
        val parsed = url.toHttpUrlOrNull() ?: throw ApiException("Not a usable server address: $url")
        val builder = Request.Builder().url(parsed).header("Accept", "application/json")
        if (!user.isNullOrBlank()) builder.header("X-Resonance-User", user)
        when (method) {
            "GET" -> builder.get()
            "DELETE" -> builder.delete()
            "POST" -> builder.post((body ?: JSONObject()).toString().toRequestBody(jsonMediaType))
            else -> builder.method(method, null)
        }
        try {
            client.newCall(builder.build()).execute().use { response ->
                val text = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    throw ApiException(serverMessage(text, response.code, response.message), response.code)
                }
                return text
            }
        } catch (e: ApiException) {
            throw e
        } catch (e: Exception) {
            throw ApiException(e.message ?: "Network error (${e.javaClass.simpleName})")
        }
    }

    private fun serverMessage(text: String, code: Int, message: String): String {
        val parsed = runCatching { JSONObject(text) }.getOrNull()
        val error = parsed?.let { it.stringOrNull("error") }
        if (!error.isNullOrBlank()) return error
        return "HTTP $code" + if (message.isBlank()) "" else " $message"
    }

    /* ------------------------------------------------------------------ endpoints */

    suspend fun health(baseUrl: String, user: String?): Health = withContext(Dispatchers.IO) {
        Health.from(JSONObject(execute("GET", buildUrl(baseUrl, "/api/health"), user, null)))
    }

    suspend fun users(baseUrl: String, user: String?): UsersPage = withContext(Dispatchers.IO) {
        UsersPage.from(JSONObject(execute("GET", buildUrl(baseUrl, "/api/users"), user, null)))
    }

    suspend fun createUser(baseUrl: String, user: String?, name: String): UserInfo = withContext(Dispatchers.IO) {
        UserInfo.from(JSONObject(execute("POST", buildUrl(baseUrl, "/api/users"), user, JSONObject().put("name", name))))
    }

    suspend fun search(baseUrl: String, user: String?, query: String): List<SearchResult> = withContext(Dispatchers.IO) {
        val text = execute("GET", buildUrl(baseUrl, "/api/search", mapOf("q" to query)), user, null)
        jsonObjectArray(text).map { SearchResult.from(it) }
    }

    suspend fun download(baseUrl: String, user: String?, url: String, autoPlay: Boolean): DownloadJob = withContext(Dispatchers.IO) {
        val body = JSONObject().put("url", url).put("autoPlay", autoPlay)
        DownloadJob.from(JSONObject(execute("POST", buildUrl(baseUrl, "/api/download"), user, body)))
    }

    suspend fun jobs(baseUrl: String, user: String?): JobsPage = withContext(Dispatchers.IO) {
        JobsPage.from(JSONObject(execute("GET", buildUrl(baseUrl, "/api/jobs"), user, null)))
    }

    suspend fun deleteJob(baseUrl: String, user: String?, id: String) = withContext(Dispatchers.IO) {
        execute("DELETE", buildUrl(baseUrl, "/api/jobs/$id"), user, null)
        Unit
    }

    suspend fun tracks(
        baseUrl: String,
        user: String?,
        path: String,
        scope: String,
        recursive: Boolean
    ): LibraryPage = withContext(Dispatchers.IO) {
        val params = LinkedHashMap<String, String?>()
        params["path"] = path.ifBlank { null }
        if (recursive) params["recursive"] = "1"
        if (scope == "shared") params["scope"] = "shared"
        LibraryPage.from(JSONObject(execute("GET", buildUrl(baseUrl, "/api/tracks", params), user, null)))
    }

    suspend fun deleteTrack(baseUrl: String, user: String?, path: String) = withContext(Dispatchers.IO) {
        execute("DELETE", buildUrl(baseUrl, "/api/track", mapOf("path" to path)), user, null)
        Unit
    }

    suspend fun shares(baseUrl: String, user: String?): SharesPage = withContext(Dispatchers.IO) {
        SharesPage.from(JSONObject(execute("GET", buildUrl(baseUrl, "/api/shares"), user, null)))
    }

    suspend fun share(
        baseUrl: String,
        user: String?,
        trackPath: String,
        to: String,
        note: String?
    ): Share = withContext(Dispatchers.IO) {
        val body = JSONObject().put("trackPath", trackPath).put("to", to)
        if (!note.isNullOrBlank()) body.put("note", note)
        Share.from(JSONObject(execute("POST", buildUrl(baseUrl, "/api/share"), user, body)))
    }

    suspend fun deleteShare(baseUrl: String, user: String?, id: String) = withContext(Dispatchers.IO) {
        execute("DELETE", buildUrl(baseUrl, "/api/shares/$id"), user, null)
        Unit
    }

    suspend fun importShare(baseUrl: String, user: String?, id: String) = withContext(Dispatchers.IO) {
        execute("POST", buildUrl(baseUrl, "/api/shares/$id/import"), user, JSONObject())
        Unit
    }
}
