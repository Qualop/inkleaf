struct ExportJobs{
    private var active=Set<String>(),cancelled=Set<String>()
    private var committed:[String:String]=[:]
    mutating func begin(_ id:String)throws{guard !id.isEmpty,active.insert(id).inserted else{throw BridgeError.invalidRequest("Export job already exists.")}}
    mutating func cancel(_ id:String)->Bool{guard active.contains(id),committed[id]==nil else{return false};cancelled.insert(id);return true}
    mutating func commit(_ id:String,path:String){committed[id]=path}
    func outputPath(_ id:String)->String?{committed[id]}
    func check(_ id:String)throws{guard active.contains(id),!cancelled.contains(id) else{throw BridgeError.cancelled}}
    mutating func finish(_ id:String){active.remove(id);cancelled.remove(id);committed.removeValue(forKey:id)}
}
