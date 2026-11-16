#![no_std]
unsafe extern "C"{
    fn fetchlet_init();
    fn fetchlet_add(a:f64,b:f64)->f64;
    fn fetchlet_multiply(a:f64,b:f64)->f64;
}

/// Rust initiates the calls into the compiled TypeScript static library.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fetchlet_rust_probe()->i32{unsafe{
    fetchlet_init();
    if fetchlet_add(20.0,22.0)!=42.0{return 1;}
    if fetchlet_multiply(6.0,7.0)!=42.0{return 2;}
    if fetchlet_add(-3.5,1.25)!=-2.25{return 3;}
    0
}}
