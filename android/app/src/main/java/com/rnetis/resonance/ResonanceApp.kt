package com.rnetis.resonance

import android.app.Application
import com.rnetis.resonance.data.Api
import com.rnetis.resonance.data.OfflineStore
import com.rnetis.resonance.data.Prefs
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * Holds the process-wide singletons: saved settings, the HTTP client and the
 * offline file store. Everything the UI needs is reachable from here.
 */
class ResonanceApp : Application() {

    lateinit var prefs: Prefs
    lateinit var api: Api
    lateinit var offline: OfflineStore

    override fun onCreate() {
        super.onCreate()
        instance = this
        prefs = Prefs(this)
        api = Api(
            OkHttpClient.Builder()
                .connectTimeout(12, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS)
                .build()
        )
        offline = OfflineStore(this, prefs)
    }

    companion object {
        lateinit var instance: ResonanceApp
    }
}
