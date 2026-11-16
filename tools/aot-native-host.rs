// Exact symbols and f64 signatures are checked against this fixture's profile / LLVM IR.
// This is an ABI experiment, not a stable compiler-independent application ABI.
#[cfg(perry)]
unsafe extern "C" {
    #[link_name="perry_module_init"] fn initialize();
    #[link_name="perry_fn_native_ts__add"] fn add(a:f64,b:f64)->f64;
    #[link_name="perry_fn_native_ts__multiply"] fn multiply(a:f64,b:f64)->f64;
    fn perry_plugin_abi_version()->u64;
}

#[cfg(scriptc)]
unsafe extern "C" {
    #[link_name="fetchlet_init"] fn initialize();
    #[link_name="fetchlet_add"] fn add(a:f64,b:f64)->f64;
    #[link_name="fetchlet_multiply"] fn multiply(a:f64,b:f64)->f64;
}

fn main(){unsafe{
    #[cfg(perry)] assert_eq!(perry_plugin_abi_version(),2);
    initialize();
    assert_eq!(add(20.0,22.0),42.0);
    assert_eq!(multiply(6.0,7.0),42.0);
    assert_eq!(add(-3.5,1.25),-2.25);
    println!("{{\"add\":42,\"multiply\":42,\"fractional\":-2.25,\"rustStaticHost\":true}}");
}}
