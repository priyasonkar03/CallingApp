package com.saigraphics.calldesk;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.telephony.PhoneStateListener;
import android.telephony.TelephonyCallback;
import android.telephony.TelephonyManager;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

// Native bridge: places a real phone call with no dialer confirmation, then
// brings the app back to the front the moment the call ends — so the agent
// never taps "call" and never presses back.
@CapacitorPlugin(
    name = "DirectCall",
    permissions = {
        @Permission(alias = "phone", strings = {
            Manifest.permission.CALL_PHONE,
            Manifest.permission.READ_PHONE_STATE
        })
    }
)
public class DirectCallPlugin extends Plugin {

    private boolean listening = false;
    private boolean wasOffHook = false;

    @PluginMethod
    public void call(PluginCall call) {
        String number = call.getString("number");
        if (number == null || number.trim().isEmpty()) {
            call.reject("No number provided");
            return;
        }
        // Ask for both CALL_PHONE and READ_PHONE_STATE if we don't have them yet.
        if (getPermissionState("phone") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("phone", call, "phonePermsCallback");
            return;
        }
        placeCall(call, number);
    }

    @PermissionCallback
    private void phonePermsCallback(PluginCall call) {
        if (getPermissionState("phone") == com.getcapacitor.PermissionState.GRANTED) {
            placeCall(call, call.getString("number"));
        } else {
            call.reject("Phone permission denied");
        }
    }

    private void placeCall(PluginCall call, String number) {
        try {
            startCallEndWatcher();
            Intent intent = new Intent(Intent.ACTION_CALL, Uri.parse("tel:" + Uri.encode(number)));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (SecurityException e) {
            call.reject("CALL_PHONE permission missing");
        } catch (Exception e) {
            call.reject("Could not place call: " + e.getMessage());
        }
    }

    // Watch the call state; when it returns to IDLE after being active,
    // bring our app back to the foreground.
    private void startCallEndWatcher() {
        if (listening) return;
        listening = true;
        wasOffHook = false;
        TelephonyManager tm = (TelephonyManager) getContext().getSystemService(Context.TELEPHONY_SERVICE);
        if (tm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            tm.registerTelephonyCallback(getContext().getMainExecutor(), new CallEndCallback());
        } else {
            tm.listen(new LegacyListener(), PhoneStateListener.LISTEN_CALL_STATE);
        }
    }

    private void handleState(int state) {
        if (state == TelephonyManager.CALL_STATE_OFFHOOK) {
            wasOffHook = true;
        } else if (state == TelephonyManager.CALL_STATE_IDLE && wasOffHook) {
            wasOffHook = false;
            bringAppToFront();
        }
    }

    private void bringAppToFront() {
        Context ctx = getContext();
        Intent launch = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (launch != null) {
            launch.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(launch);
        }
    }

    // API 31+ callback
    private class CallEndCallback extends TelephonyCallback implements TelephonyCallback.CallStateListener {
        @Override
        public void onCallStateChanged(int state) {
            handleState(state);
        }
    }

    // API < 31 listener
    private class LegacyListener extends PhoneStateListener {
        @Override
        public void onCallStateChanged(int state, String phoneNumber) {
            handleState(state);
        }
    }
}
