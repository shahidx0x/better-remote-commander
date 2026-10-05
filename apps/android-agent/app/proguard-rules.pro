# BRC Android release rules.
# Shizuku UserService is loaded by class name from a privileged remote process.
-keep class io.github.shahidx0x.brc.android.privilege.ShizukuShellService { *; }
-keep class io.github.shahidx0x.brc.android.privilege.IShizukuShellService* { *; }
