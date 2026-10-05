package io.github.shahidx0x.brc.android.privilege;

import android.os.Bundle;

interface IShizukuShellService {
    Bundle execute(String command, int timeoutMs, int maxOutputBytes) = 1;
    int uid() = 2;
    void destroy() = 16777114;
}
