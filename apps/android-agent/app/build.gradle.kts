plugins {
    id("com.android.application")
}

android {
    namespace = "io.github.shahidx0x.brc.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.shahidx0x.brc.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0-dev"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:5.3.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("com.google.crypto.tink:tink-android:1.23.0")
    testImplementation("junit:junit:4.13.2")
}
