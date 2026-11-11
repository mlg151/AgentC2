plugins { id("com.android.application"); jacoco }
android {
    namespace = "com.agentc2.companion"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.agentc2.companion"
        minSdk = 29
        targetSdk = 36
        versionCode = 4018
        versionName = "0.4.18"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    signingConfigs {
        create("release") {
            storeFile = providers.environmentVariable("AGENTC2_ANDROID_KEYSTORE").map { file(it) }.orNull
            storePassword = System.getenv("AGENTC2_ANDROID_STORE_PASSWORD")
            keyAlias = System.getenv("AGENTC2_ANDROID_KEY_ALIAS")
            keyPassword = System.getenv("AGENTC2_ANDROID_KEY_PASSWORD")
        }
    }
    buildTypes {
        debug { enableUnitTestCoverage = true; enableAndroidTestCoverage = true }
        release { signingConfig = signingConfigs.getByName("release") }
    }
    testOptions { unitTests.isIncludeAndroidResources = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
}
dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.16.1")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
}
jacoco { toolVersion = "0.8.14" }
val classes = fileTree(layout.buildDirectory.dir("intermediates/built_in_kotlinc/debug/compileDebugKotlin/classes"))
val coverageReport = tasks.register<JacocoReport>("coverageReport") {
    dependsOn("testDebugUnitTest")
    mustRunAfter("connectedDebugAndroidTest")
    executionData(layout.buildDirectory.file("outputs/unit_test_code_coverage/debugUnitTest/testDebugUnitTest.exec"),
        fileTree(layout.buildDirectory.dir("outputs/code_coverage/debugAndroidTest/connected")) { include("**/*.ec") })
    classDirectories.setFrom(classes)
    sourceDirectories.setFrom(files("src/main/java"))
    reports { xml.required = true; html.required = true }
}
tasks.register<JacocoCoverageVerification>("verifyCoverage") {
    dependsOn(coverageReport)
    executionData(coverageReport.get().executionData)
    classDirectories.setFrom(classes)
    sourceDirectories.setFrom(files("src/main/java"))
    violationRules { rule { limit { counter = "LINE"; minimum = "1.0".toBigDecimal() }; limit { counter = "BRANCH"; minimum = "1.0".toBigDecimal() } } }
}
tasks.withType<Test>().configureEach {
    extensions.configure<JacocoTaskExtension> {
        isIncludeNoLocationClasses = true
        includes = listOf("com.agentc2.companion.*")
    }
}
