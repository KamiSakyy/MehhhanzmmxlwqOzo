# JNI: имена нативных методов не должны переименовываться
-keepclasseswithmembernames class * { native <methods>; }
-keep class com.mehhanz.engine.crypto.NativeCrypto { *; }
-keep class com.mehhanz.studio.MainActivity { *; }
-keep class com.mehhanz.studio.StudioActivity { *; }
-keep class com.mehhanz.studio.game.GameActivity { *; }
-keep class com.mehhanz.studio.* { public protected *; }
# сохраняем исключения и отладочную информацию в логах
-keepattributes SourceFile,LineNumberTable,Exceptions,*Annotation*
-renamesourcefileattribute Src
# наши движковые классы рефлексией не грузим, но лямбды/интерфейсы сохраняем
-keepclassmembers class * { @** <methods>; }
