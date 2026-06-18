fn main() { 
    let ip: [u8; 4] = [183, 197, 130, 97]; 
    let val = u32::from_ne_bytes(ip); 
    println!("ne: {:?}", val.to_ne_bytes()); 
    println!("be: {:?}", val.to_be_bytes()); 
    println!("le: {:?}", val.to_le_bytes()); 
}
