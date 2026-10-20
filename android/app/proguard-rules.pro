# The debug build is not minified, so these rules only matter for a release build.
# Keep JSON "models" and anything the reflection-free code paths touch by name.

# OkHttp ships its own consumer rules.
-dontwarn okhttp3.**
-dontwarn okio.**

# org.json is part of the platform; nothing to keep.
-keepclassmembers class * {
    @androidx.annotation.Keep <methods>;
}
