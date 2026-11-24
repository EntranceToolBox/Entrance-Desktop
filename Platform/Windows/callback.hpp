#pragma once
#include <unknwn.h>
#include <wrl/client.h>

// WebView2 retains these single-method COM handlers after registration.
template<class Interface, class... Args>
class WebViewHandler final : public Interface {
public:
    using Function = HRESULT (*)(Args...);

    WebViewHandler(const IID &id, Function function) : id_(id), function_(function) {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void **out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        if (!IsEqualIID(id, IID_IUnknown) && !IsEqualIID(id, id_)) return E_NOINTERFACE;
        *out = static_cast<Interface *>(this);
        AddRef();
        return S_OK;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&references_); }
    ULONG STDMETHODCALLTYPE Release() override {
        const ULONG remaining = InterlockedDecrement(&references_);
        if (!remaining) delete this;
        return remaining;
    }
    HRESULT STDMETHODCALLTYPE Invoke(Args... args) override { return function_(args...); }

private:
    LONG references_ = 1;
    IID id_;
    Function function_;
};

template<class Interface, class... Args>
Microsoft::WRL::ComPtr<Interface> makeHandler(const IID &id, HRESULT (*function)(Args...)) {
    Microsoft::WRL::ComPtr<Interface> handler;
    handler.Attach(new WebViewHandler<Interface, Args...>(id, function));
    return handler;
}
