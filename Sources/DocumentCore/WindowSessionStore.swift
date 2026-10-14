import Foundation

public struct WindowFrame:Codable,Sendable,Equatable {
    public let x:Double,y:Double,width:Double,height:Double
    public init(x:Double,y:Double,width:Double,height:Double){self.x=x;self.y=y;self.width=width;self.height=height}
    public var isValid:Bool{[x,y,width,height].allSatisfy(\.isFinite) && width>=620 && height>=420 && width<=20000 && height<=20000}
}
public struct WindowSessionContent:Codable,Sendable,Equatable {
    public struct Document:Codable,Sendable,Equatable {
        public let documentId:String
        public let path:String?
    }
    public let paths:[String]
    public let activePath:String?
    public let workspace:String?
    public let views:[String:JSONValue]
    public let documents:[Document]?
    public let activeDocumentId:String?
    public let draftRevisions:[String:Int]
    public static var empty:Self{try! Self(values:[:])}
    public init(values:[String:JSONValue])throws{
        func path(_ value:JSONValue?)throws->String?{
            guard let value,value != .null else{return nil}
            guard case .string(let text)=value,text.hasPrefix("/"),!text.contains("\0") else{throw DocumentError.invalidPath("Window session paths must be absolute.")};return text
        }
        var paths:[String]=[]
        if let value=values["paths"]{guard case .array(let items)=value,items.count<=512 else{throw DocumentError.invalidPath("Invalid window session tab list.")};for item in items{guard let text=try path(item) else{throw DocumentError.invalidPath("Window session tab path is missing.")};if !paths.contains(text){paths.append(text)}}}
        self.paths=paths
        let active=try path(values["activePath"]);activePath=active.flatMap{paths.contains($0) ? $0:nil}
        workspace=try path(values["workspace"])
        var identities=Set<String>()
        if let value=values["documents"] {
            guard case .array(let items)=value,items.count<=512 else{throw DocumentError.invalidPath("Invalid session documents.")}
            documents=try items.map{item in
                guard case .object(let fields)=item,case .string(let id)=fields["documentId"],!id.isEmpty,id.count<=128,!id.contains("\0"),identities.insert(id).inserted else{throw DocumentError.invalidPath("Invalid or duplicate session document identity.")}
                return Document(documentId:id,path:try path(fields["path"]))
            }
            if let active=values["activeDocumentId"],active != .null {
                guard case .string(let id)=active else{throw DocumentError.invalidPath("Invalid active document identity.")}
                activeDocumentId=identities.contains(id) ? id:nil
            } else {activeDocumentId=nil}
        } else {documents=nil;activeDocumentId=nil}
        var drafts:[String:Int]=[:]
        if let value=values["draftRevisions"] {
            guard case .object(let items)=value else{throw DocumentError.invalidPath("Invalid session draft revisions.")}
            for (id,value) in items where identities.contains(id) {
                guard case .number(let revision)=value,revision.isFinite,revision>=0,revision<=9_007_199_254_740_991,revision.rounded()==revision else{throw DocumentError.invalidPath("Invalid draft revision.")}
                drafts[id]=Int(revision)
            }
        }
        draftRevisions=drafts
        var validViews:[String:JSONValue]=[:]
        if let value=values["views"]{
            guard case .object(let items)=value else{throw DocumentError.invalidPath("Window view positions must be an object.")}
            for (key,value) in items where paths.contains(key) || identities.contains(key){
                guard case .object(let fields)=value,case .number(let anchor)=fields["anchor"],case .number(let head)=fields["head"],case .number(let scroll)=fields["scroll"],anchor.isFinite,head.isFinite,scroll.isFinite,anchor>=0,head>=0,scroll>=0,anchor<=1e9,head<=1e9,scroll<=1e8,anchor.rounded()==anchor,head.rounded()==head else{throw DocumentError.invalidPath("Invalid window cursor or scroll position.")}
                validViews[key] = .object(["anchor":.number(anchor),"head":.number(head),"scroll":.number(scroll)])
            }
        };views=validViews
    }
    public init(from decoder:any Decoder)throws{let value=try JSONValue(from:decoder);guard case .object(let values)=value else{throw DocumentError.invalidPath("Invalid window session data.")};try self.init(values:values)}
    public func encode(to encoder:any Encoder)throws{try json.encode(to:encoder)}
    public var json:JSONValue{
        var result:[String:JSONValue]=["paths":.array(paths.map(JSONValue.string)),"activePath":activePath.map(JSONValue.string) ?? .null,"workspace":workspace.map(JSONValue.string) ?? .null]
        if let documents {
            result["documents"] = .array(documents.map{.object(["documentId":.string($0.documentId),"path":$0.path.map(JSONValue.string) ?? .null])})
            result["activeDocumentId"] = activeDocumentId.map(JSONValue.string) ?? .null
        }
        if !views.isEmpty{result["views"] = .object(views)}
        if !draftRevisions.isEmpty {result["draftRevisions"] = .object(draftRevisions.mapValues{.number(Double($0))})}
        return .object(result)
    }
}
public struct WindowSession:Codable,Sendable,Equatable {
    public let id:String
    public var content:WindowSessionContent
    public var frame:WindowFrame?
}

/// Shared by all native windows. Closing removes only that window; quitting preserves the set.
public actor WindowSessionStore {
    private let directory:URL
    private var focusedID:String?
    private var file:URL{directory.appendingPathComponent("window-sessions.json")}
    public init(dataDirectory:URL){directory=dataDirectory}
    public func hasSavedState()->Bool{FileManager.default.fileExists(atPath:file.path)}
    public func all()throws->[WindowSession]{
        guard FileManager.default.fileExists(atPath:file.path) else{return []}
        do{return try JSONDecoder().decode([WindowSession].self,from:FileIO.read(file))}
        catch{throw FileIO.mapped(error,path:file.path)}
    }
    public func update(id:String,values:[String:JSONValue],frame:WindowFrame?)throws{
        guard !id.isEmpty,id.count<=128,frame?.isValid != false else{throw DocumentError.invalidPath("Invalid window identity or geometry.")}
        let content=try WindowSessionContent(values:values);var records=try all()
        if let index=records.firstIndex(where:{$0.id==id}){records[index].content=content;if let frame{records[index].frame=frame}}
        else{records.append(WindowSession(id:id,content:content,frame:frame))}
        if let focusedID,let index=records.firstIndex(where:{$0.id==focusedID}),index != records.count-1{records.append(records.remove(at:index))}
        try write(records)
    }
    public func updateFrame(id:String,frame:WindowFrame)throws{
        guard frame.isValid else{throw DocumentError.invalidPath("Invalid window geometry.")}
        var records=try all();guard let index=records.firstIndex(where:{$0.id==id}) else{return};records[index].frame=frame;try write(records)
    }
    public func focus(id:String)throws{
        focusedID=id
        var records=try all();guard let index=records.firstIndex(where:{$0.id==id}),index != records.count-1 else{return}
        records.append(records.remove(at:index));try write(records)
    }
    public func remove(id:String)throws{var records=try all();records.removeAll{$0.id==id};if focusedID==id{focusedID=nil};try write(records)}
    private func write(_ records:[WindowSession])throws{
        do{try FileIO.directory(directory,create:true);let encoder=JSONEncoder();encoder.outputFormatting=[.prettyPrinted,.sortedKeys];try FileIO.write(encoder.encode(records),to:file)}
        catch{throw FileIO.mapped(error,path:file.path)}
    }
}
